import { expect, test } from "bun:test";

import {
  BULK_METADATA_DISCOVERY_CONCURRENCY,
  discoverBulkMetadataCandidates,
} from "./bulk-metadata-candidates";

function item(id: string) {
  return { id, title: id, formats: [], tags: [] } as never;
}

function found(id: string) {
  return { ok: true, value: { item: item(id) } } as const;
}

function candidates(id: string) {
  return {
    ok: true,
    value: {
      itemId: id,
      candidates: [{ id: `candidate-${id}`, provenance: { itemId: id } }],
    },
  } as never;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("discovers with fixed maximum concurrency two and preserves requested order", async () => {
  expect(BULK_METADATA_DISCOVERY_CONCURRENCY).toBe(2);
  let active = 0;
  let maximum = 0;
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const ids = ["one", "two", "three", "four"];
  for (const id of ids) gates.set(id, deferred<void>());

  const pending = discoverBulkMetadataCandidates(
    { itemIds: ids, includeOnline: false },
    {
      getItem: async (id) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gates.get(id)!.promise;
        active -= 1;
        return found(id);
      },
      listCandidates: async ({ itemId }) => candidates(itemId),
    },
  );

  await Promise.resolve();
  expect(active).toBe(2);
  gates.get("two")!.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(active).toBe(2);
  gates.get("one")!.resolve();
  gates.get("three")!.resolve();
  await Promise.resolve();
  await Promise.resolve();
  gates.get("four")!.resolve();

  const result = await pending;
  expect(maximum).toBe(2);
  expect(result.outcomes.map(({ itemId }) => itemId)).toEqual(ids);
  expect(result.outcomes.map(({ status }) => status)).toEqual([
    "ready",
    "ready",
    "ready",
    "ready",
  ]);
});

test("cancellation stops scheduling, lets in-flight work settle, and accounts every ID", async () => {
  const gates = [deferred<void>(), deferred<void>()];
  let canceled = false;
  const started: string[] = [];
  const pending = discoverBulkMetadataCandidates(
    { itemIds: ["one", "two", "three", "four", "five"], includeOnline: true },
    {
      getItem: async (id) => {
        started.push(id);
        await gates[started.length - 1]!.promise;
        return found(id);
      },
      listCandidates: async ({ itemId }) => candidates(itemId),
      isCanceled: () => canceled,
    },
  );

  await Promise.resolve();
  canceled = true;
  gates[0].resolve();
  gates[1].resolve();
  const result = await pending;

  expect(started).toEqual(["one", "two"]);
  expect(result.outcomes.map(({ status }) => status)).toEqual([
    "ready",
    "ready",
    "canceled",
    "canceled",
    "canceled",
  ]);
  expect(result.counts).toEqual({
    total: 5,
    ready: 2,
    "no-candidates": 0,
    missing: 0,
    failed: 0,
    canceled: 3,
  });
});

test("classifies missing, failed, no-candidate, and thrown lookups exactly", async () => {
  const result = await discoverBulkMetadataCandidates(
    { itemIds: ["ready", "missing", "lookup-failure", "none", "throw"], includeOnline: false },
    {
      getItem: async (id) => {
        if (id === "missing") return { ok: true, value: { item: null } } as const;
        if (id === "lookup-failure") return { ok: false, error: { code: "protocol-error" } } as const;
        if (id === "throw") throw new Error("boom");
        return found(id);
      },
      listCandidates: async ({ itemId }) =>
        itemId === "none"
          ? ({ ok: true, value: { itemId, candidates: [] } } as const)
          : candidates(itemId),
    },
  );

  expect(result.outcomes.map(({ status }) => status)).toEqual([
    "ready",
    "missing",
    "failed",
    "no-candidates",
    "failed",
  ]);
  expect(result.counts).toEqual({
    total: 5,
    ready: 1,
    "no-candidates": 1,
    missing: 1,
    failed: 2,
    canceled: 0,
  });
});
