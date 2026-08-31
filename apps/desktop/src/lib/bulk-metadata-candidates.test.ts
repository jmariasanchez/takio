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
  const discarded: string[] = [];
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
      discardCandidates: async (values) => {
        discarded.push(...values.map(({ id }) => id));
      },
    },
  );

  await Promise.resolve();
  canceled = true;
  gates[0].resolve();
  gates[1].resolve();
  const result = await pending;

  expect(started).toEqual(["one", "two"]);
  expect(result.outcomes.map(({ status }) => status)).toEqual([
    "canceled",
    "canceled",
    "canceled",
    "canceled",
    "canceled",
  ]);
  expect(result.counts).toEqual({
    total: 5,
    ready: 0,
    "no-candidates": 0,
    missing: 0,
    failed: 0,
    canceled: 5,
  });
  expect(discarded).toEqual([]);
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
  expect(result.outcomes[2]).toEqual({
    itemId: "lookup-failure",
    status: "failed",
    code: "protocol-error",
  });
  expect(result.outcomes[4]).toEqual({
    itemId: "throw",
    status: "failed",
    code: "unexpected-error",
  });
  expect(result.counts).toEqual({
    total: 5,
    ready: 1,
    "no-candidates": 1,
    missing: 1,
    failed: 2,
    canceled: 0,
  });
});

test("classifies a book removed between hydration and candidate lookup as missing", async () => {
  const result = await discoverBulkMetadataCandidates(
    { itemIds: ["removed"], includeOnline: false },
    {
      getItem: async (id) => found(id),
      listCandidates: async () => ({
        ok: false,
        error: { code: "item-not-found" },
      }),
    },
  );

  expect(result.outcomes).toEqual([{ itemId: "removed", status: "missing" }]);
  expect(result.counts).toEqual({
    total: 1,
    ready: 0,
    "no-candidates": 0,
    missing: 1,
    failed: 0,
    canceled: 0,
  });
});

test("rejects and discards every candidate when any candidate belongs to another item", async () => {
  const discarded: string[] = [];
  const result = await discoverBulkMetadataCandidates(
    { itemIds: ["one"], includeOnline: false },
    {
      getItem: async (id) => found(id),
      listCandidates: async () => ({
        ok: true,
        value: {
          itemId: "one",
          candidates: [
            { id: "candidate-one", provenance: { itemId: "one" } },
            { id: "candidate-two", provenance: { itemId: "two" } },
          ],
        },
      }) as never,
      discardCandidates: async (values) => {
        discarded.push(...values.map(({ id }) => id));
      },
    },
  );

  expect(result.outcomes).toEqual([{ itemId: "one", status: "failed", code: "protocol-error" }]);
  expect(discarded).toEqual(["candidate-one", "candidate-two"]);
});
