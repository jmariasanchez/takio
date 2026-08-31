import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

GlobalRegistrator.register();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LibraryBulkMetadataCandidateDialog } = await import("./LibraryBulkMetadataCandidateDialog");

type Props = Parameters<typeof LibraryBulkMetadataCandidateDialog>[0];
type GetItem = NonNullable<Props["getItem"]>;
type ListCandidates = NonNullable<Props["listCandidates"]>;
type ApplyCandidate = NonNullable<Props["applyCandidate"]>;

function item(id: string, title = id) {
  return {
    id,
    title,
    sourcePath: `/Books/${id}.epub`,
    format: "epub",
    addedAt: "2026-08-31T10:00:00.000Z",
    formats: [{ sourcePath: `/Books/${id}.epub`, format: "epub", addedAt: "2026-08-31T10:00:00.000Z", provenance: "managed" }],
    tags: [],
  } as never;
}

function candidate(itemId: string, withCover = false) {
  const cover = {
    artifactId: "0123456789abcdef0123456789abcdef",
    mediaType: "image/jpeg",
    extension: ".jpg",
    bytes: 6,
    sha256: "a".repeat(64),
  } as const;
  return {
    schemaVersion: 1,
    id: `filename:${itemId}`,
    source: "filename",
    confidence: "medium",
    patch: { title: `Discovered ${itemId}`, publisher: "New publisher" },
    ...(withCover ? { cover } : {}),
    provenance: {
      generatedAt: "2026-08-31T10:00:00.000Z",
      itemId,
      sourcePath: `/Books/${itemId}.epub`,
      pattern: "(?<title>.+)",
    },
  } as const;
}

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(element));
  return host;
}

function button(label: string) {
  const match = [...host!.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button ${label}`);
  return match as HTMLButtonElement;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(callback, 0) });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  document.body.replaceChildren();
});

afterAll(() => GlobalRegistrator.unregister());

const getItem: GetItem = async (id) => ({ ok: true, value: { item: item(id) } });
const applyCandidate: ApplyCandidate = async (request) => ({
  ok: true,
  value: {
    item: item(request.itemId, `Applied ${request.itemId}`),
    applied: {
      itemId: request.itemId,
      candidateId: request.candidate.id,
      source: request.candidate.source,
      provenance: request.provenance,
      fields: request.fields,
      coverApplied: request.cover,
      ...(request.cover && request.candidate.cover ? { cover: {
        mediaType: request.candidate.cover.mediaType,
        extension: request.candidate.cover.extension,
        bytes: request.candidate.cover.bytes,
        sha256: request.candidate.cover.sha256,
      } } : {}),
    },
  },
});

test("online discovery is explicit and selective apply records only checked fields", async () => {
  const requests: Array<{ itemId: string; includeOnline: boolean }> = [];
  const applied: unknown[] = [];
  const list: ListCandidates = async (request) => {
    requests.push(request);
    return { ok: true, value: { itemId: request.itemId, candidates: [candidate(request.itemId)] } };
  };
  mount(<LibraryBulkMetadataCandidateDialog open itemIds={["one"]} onClose={() => undefined} onApplied={(value) => applied.push(value)} getItem={getItem} listCandidates={list} applyCandidate={async (request) => {
    expect(request.fields).toEqual(["publisher"]);
    expect(request.cover).toBe(false);
    return applyCandidate(request);
  }} />);

  expect((host!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  act(() => button("Start review").click());
  await flush();
  expect(requests).toEqual([{ itemId: "one", includeOnline: false }]);

  const publisher = [...host!.querySelectorAll("label")].find((label) => label.textContent?.includes("publisher"))!.querySelector("input")!;
  act(() => publisher.click());
  act(() => button("Apply selection").click());
  await flush();

  expect(applied).toHaveLength(1);
  expect(host!.textContent).toContain("Review complete");
  expect(host!.textContent).toContain("applied1");
});

test("bulk review keeps cover explicit and supports cover-only apply with final accounting", async () => {
  const requests: Parameters<ApplyCandidate>[0][] = [];
  const list: ListCandidates = async (request) => ({ ok: true, value: { itemId: request.itemId, candidates: [candidate(request.itemId, true)] } });
  mount(<LibraryBulkMetadataCandidateDialog open itemIds={["one"]} onClose={() => undefined} onApplied={() => undefined} getItem={getItem} listCandidates={list} applyCandidate={async (request) => { requests.push(request); return applyCandidate(request); }} />);
  act(() => button("Start review").click());
  await flush();

  const coverCheckbox = host!.querySelector<HTMLInputElement>('input[aria-label^="Apply candidate cover"]')!;
  expect(coverCheckbox.checked).toBe(false);
  expect(button("Apply selection").disabled).toBe(true);
  act(() => coverCheckbox.click());
  act(() => button("Apply selection").click());
  await flush();

  expect(requests[0]?.fields).toEqual([]);
  expect(requests[0]?.cover).toBe(true);
  expect(host!.textContent).toContain("Review complete");
  expect(host!.textContent).not.toContain("final review report did not account");
});

test("bulk review rejects mismatched apply responses before advancing", async () => {
  const list: ListCandidates = async (request) => ({ ok: true, value: { itemId: request.itemId, candidates: [candidate(request.itemId)] } });
  const mismatch: ApplyCandidate = async (request) => {
    const result = await applyCandidate(request);
    if (!result.ok) return result;
    return { ...result, value: { ...result.value, applied: { ...result.value.applied, source: "embedded" } } } as never;
  };
  mount(<LibraryBulkMetadataCandidateDialog open itemIds={["one"]} onClose={() => undefined} onApplied={() => undefined} getItem={getItem} listCandidates={list} applyCandidate={mismatch} />);
  act(() => button("Start review").click());
  await flush();
  const publisher = [...host!.querySelectorAll("label")].find((label) => label.textContent?.includes("publisher"))!.querySelector("input")!;
  act(() => publisher.click());
  act(() => button("Apply selection").click());
  await flush();
  expect(host!.querySelector('[role="alert"]')?.textContent).toContain("did not match the selected candidate");
  expect(host!.textContent).not.toContain("Review complete");
});

test("skip advances one book at a time and leaves candidates unapplied", async () => {
  const list: ListCandidates = async (request) => ({ ok: true, value: { itemId: request.itemId, candidates: [candidate(request.itemId)] } });
  mount(<LibraryBulkMetadataCandidateDialog open itemIds={["one", "two"]} onClose={() => undefined} onApplied={() => undefined} getItem={getItem} listCandidates={list} applyCandidate={applyCandidate} />);
  act(() => button("Start review").click());
  await flush();
  expect(host!.textContent).toContain("one");
  act(() => button("Skip").click());
  expect(host!.textContent).toContain("two");
  act(() => button("Skip").click());
  expect(host!.textContent).toContain("skipped2");
});

test("cancel stops scheduling, announces settling, and restores opener focus on close", async () => {
  const opener = document.createElement("button");
  opener.textContent = "Open review";
  document.body.append(opener);
  opener.focus();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const slowGet: GetItem = async (id) => {
    started.push(id);
    await gate;
    return { ok: true, value: { item: item(id) } };
  };
  const list: ListCandidates = async (request) => ({ ok: true, value: { itemId: request.itemId, candidates: [] } });
  mount(<LibraryBulkMetadataCandidateDialog open itemIds={["one", "two", "three", "four"]} onClose={() => undefined} onApplied={() => undefined} getItem={slowGet} listCandidates={list} applyCandidate={applyCandidate} />);
  await flush();
  act(() => button("Start review").click());
  await flush();
  expect(host!.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
  act(() => button("Cancel discovery").click());
  expect(host!.querySelector('[role="status"]')?.textContent).toContain("Waiting for active book checks");
  release();
  await flush();
  expect(started).toEqual(["one", "two"]);
  expect(host!.textContent).toContain("canceled4");

  act(() => root?.render(<LibraryBulkMetadataCandidateDialog open={false} itemIds={[]} onClose={() => undefined} onApplied={() => undefined} />));
  expect(document.activeElement).toBe(opener);
});

test("restores focus to library search when applying the last book removes the opener", async () => {
  const search = document.createElement("input");
  search.id = "library-search";
  document.body.append(search);
  const opener = document.createElement("button");
  opener.textContent = "Open review";
  document.body.append(opener);
  opener.focus();
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: { itemId: request.itemId, candidates: [candidate(request.itemId)] },
  });
  mount(
    <LibraryBulkMetadataCandidateDialog
      open
      itemIds={["one"]}
      onClose={() => undefined}
      onApplied={() => opener.remove()}
      getItem={getItem}
      listCandidates={list}
      applyCandidate={applyCandidate}
    />,
  );

  act(() => button("Start review").click());
  await flush();
  const publisher = [...host!.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("publisher"))!
    .querySelector("input")!;
  act(() => publisher.click());
  act(() => button("Apply selection").click());
  await flush();
  act(() =>
    root?.render(
      <LibraryBulkMetadataCandidateDialog
        open={false}
        itemIds={[]}
        onClose={() => undefined}
        onApplied={() => undefined}
      />,
    ),
  );

  expect(document.activeElement).toBe(search);
});

test("recaptures focus when a phase change removes the focused setup control", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowGet: GetItem = async (id) => {
    await gate;
    return { ok: true, value: { item: item(id) } };
  };
  mount(
    <LibraryBulkMetadataCandidateDialog
      open
      itemIds={["one"]}
      onClose={() => undefined}
      onApplied={() => undefined}
      getItem={slowGet}
      listCandidates={async (request) => ({
        ok: true,
        value: { itemId: request.itemId, candidates: [] },
      })}
      applyCandidate={applyCandidate}
    />,
  );

  const start = button("Start review");
  start.focus();
  act(() => start.click());
  await flush();
  expect(document.activeElement).not.toBe(button("Cancel discovery"));
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  document.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(button("Cancel discovery"));
  release();
  await flush();
});
