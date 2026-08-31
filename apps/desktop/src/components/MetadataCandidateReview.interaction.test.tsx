import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

GlobalRegistrator.register();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MetadataCandidateReview } = await import("./MetadataCandidateReview");

type Props = Parameters<typeof MetadataCandidateReview>[0];
type Item = Props["item"];
type ListCandidates = NonNullable<Props["listCandidates"]>;
type ApplyCandidate = NonNullable<Props["applyCandidate"]>;
type DiscardCandidates = NonNullable<Props["discardCandidates"]>;

function item(id: string, title: string): Item {
  return {
    id,
    title,
    sourcePath: `/Books/${id}.epub`,
    format: "epub",
    addedAt: "2026-08-30T20:00:00.000Z",
    formats: [
      {
        sourcePath: `/Books/${id}.epub`,
        format: "epub",
        addedAt: "2026-08-30T20:00:00.000Z",
        provenance: "managed",
      },
    ],
    tags: [],
  } as unknown as Item;
}

function candidate(itemId: string, title: string, withCover = false) {
  const cover = {
    artifactId: "0123456789abcdef0123456789abcdef",
    mediaType: "image/jpeg",
    extension: ".jpg",
    bytes: 6,
    sha256: "a".repeat(64),
  } as const;
  return {
    schemaVersion: 1,
    id: "filename:1",
    source: "filename",
    confidence: "medium",
    patch: { title },
    ...(withCover ? { cover } : {}),
    provenance: {
      generatedAt: "1970-01-01T00:00:00.000Z",
      itemId,
      sourcePath: `/Books/${itemId}.epub`,
      pattern: "(?<title>.+)",
    },
  } as const;
}

let container: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount(element: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
  return container;
}

function render(element: React.ReactElement): void {
  act(() => {
    root?.render(element);
  });
}

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function statusText(host: HTMLElement): string {
  return host.querySelector('[role="status"]')?.textContent ?? "";
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button labelled ${label}`);
  return match as HTMLButtonElement;
}

const acceptingApply: ApplyCandidate = async (request) => ({
  ok: true,
  value: {
    item: item(request.itemId, "Discovered title"),
    applied: {
      itemId: request.itemId,
      candidateId: request.candidate.id,
      source: request.candidate.source,
      provenance: request.provenance,
      fields: [...request.fields],
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

test("reviewing lists only candidates bound to the selected item", async () => {
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: {
      itemId: request.itemId,
      candidates: [candidate(request.itemId, "Discovered title")],
    },
  });
  const host = mount(
    <MetadataCandidateReview
      item={item("book-1", "Current")}
      onApplied={() => undefined}
      listCandidates={list}
    />,
  );

  await act(async () => {
    button(host, "Review").click();
  });

  expect(host.textContent).toContain("Discovered title");
  expect(statusText(host)).toContain("Found 1 metadata candidate");
});

test("ignores a stale list response that resolves after the selection changed", async () => {
  type ListResult = Awaited<ReturnType<ListCandidates>>;
  let resolveFirst: ((value: ListResult) => void) | null = null;
  const list: ListCandidates = async (request) => {
    if (request.itemId === "book-1") {
      return await new Promise<ListResult>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return {
      ok: true,
      value: { itemId: request.itemId, candidates: [candidate(request.itemId, "Second title")] },
    };
  };

  const host = mount(
    <MetadataCandidateReview
      item={item("book-1", "First")}
      onApplied={() => undefined}
      listCandidates={list}
    />,
  );
  act(() => {
    button(host, "Review").click();
  });
  render(
    <MetadataCandidateReview
      item={item("book-2", "Second")}
      onApplied={() => undefined}
      listCandidates={list}
    />,
  );

  await act(async () => {
    resolveFirst?.({
      ok: true,
      value: { itemId: "book-1", candidates: [candidate("book-1", "Stale title")] },
    });
    await Promise.resolve();
  });

  expect(host.textContent).not.toContain("Stale title");
  expect(statusText(host)).toBe("");
});

test("releases cover stages from a stale list response", async () => {
  type ListResult = Awaited<ReturnType<ListCandidates>>;
  let resolveFirst: ((value: ListResult) => void) | null = null;
  const discarded: string[] = [];
  const list: ListCandidates = async () => await new Promise<ListResult>((resolve) => { resolveFirst = resolve; });
  const discardCandidates: DiscardCandidates = async (values) => {
    discarded.push(...values.flatMap(({ cover }) => cover ? [cover.artifactId] : []));
  };
  const host = mount(<MetadataCandidateReview item={item("book-1", "First")} onApplied={() => undefined} listCandidates={list} discardCandidates={discardCandidates} />);
  act(() => button(host, "Review").click());
  render(<MetadataCandidateReview item={item("book-2", "Second")} onApplied={() => undefined} listCandidates={list} discardCandidates={discardCandidates} />);
  await act(async () => {
    resolveFirst?.({ ok: true, value: { itemId: "book-1", candidates: [candidate("book-1", "Stale", true)] } });
    await Promise.resolve();
  });
  expect(discarded).toEqual(["0123456789abcdef0123456789abcdef"]);
});

test("releases retained cover stages on refresh, item change, and unmount", async () => {
  const discarded: string[] = [];
  const discardCandidates: DiscardCandidates = async (values) => {
    discarded.push(...values.map(({ id }) => id));
  };
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: { itemId: request.itemId, candidates: [candidate(request.itemId, "Discovered title", true)] },
  });
  const common = { onApplied: () => undefined, listCandidates: list, discardCandidates };
  const host = mount(<MetadataCandidateReview item={item("book-1", "First")} {...common} />);

  await act(async () => button(host, "Review").click());
  await act(async () => button(host, "Review").click());
  render(<MetadataCandidateReview item={item("book-2", "Second")} {...common} />);
  await act(async () => button(host, "Review").click());
  act(() => root?.unmount());
  root = null;

  expect(discarded).toEqual(["filename:1", "filename:1", "filename:1"]);
});

test("releases a candidate cover after metadata-only apply", async () => {
  const discarded: string[] = [];
  const requests: Parameters<ApplyCandidate>[0][] = [];
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: { itemId: request.itemId, candidates: [candidate(request.itemId, "Discovered title", true)] },
  });
  const host = mount(
    <MetadataCandidateReview
      item={item("book-1", "Current")}
      onApplied={() => undefined}
      listCandidates={list}
      applyCandidate={async (request) => {
        requests.push(request);
        return acceptingApply(request);
      }}
      discardCandidates={async (values) => {
        discarded.push(...values.map(({ id }) => id));
      }}
    />,
  );

  await act(async () => button(host, "Review").click());
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.click());
  await act(async () => button(host, "Apply selection").click());

  expect(requests[0]?.cover).toBe(false);
  expect(discarded).toEqual(["filename:1"]);
});

test("ignores a stale apply response and never reports it as applied", async () => {
  const applied: string[] = [];
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: { itemId: request.itemId, candidates: [candidate(request.itemId, "Discovered title")] },
  });
  type ApplyResult = Awaited<ReturnType<ApplyCandidate>>;
  let resolveApply: ((value: ApplyResult) => void) | null = null;
  const apply: ApplyCandidate = async () =>
    await new Promise<ApplyResult>((resolve) => {
      resolveApply = resolve;
    });

  const host = mount(
    <MetadataCandidateReview
      item={item("book-1", "First")}
      onApplied={(value) => applied.push(value.id)}
      listCandidates={list}
      applyCandidate={apply}
    />,
  );
  await act(async () => {
    button(host, "Review").click();
  });
  const checkbox = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
  await act(async () => {
    checkbox?.click();
  });
  act(() => {
    button(host, "Apply selection").click();
  });
  render(
    <MetadataCandidateReview
      item={item("book-2", "Second")}
      onApplied={(value) => applied.push(value.id)}
      listCandidates={list}
      applyCandidate={apply}
    />,
  );
  await act(async () => {
    resolveApply?.({
      ok: true,
      value: {
        item: item("book-1", "Discovered title"),
        applied: {
          itemId: "book-1",
          candidateId: "filename:1",
          source: "filename",
          provenance: "desktop-candidate-review:filename",
          fields: ["title"],
          coverApplied: false,
        },
      },
    });
    await Promise.resolve();
  });

  expect(applied).toEqual([]);
  expect(statusText(host)).toBe("");
});

test("rejects a mismatched apply response before reporting UI success", async () => {
  const applied: string[] = [];
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: { itemId: request.itemId, candidates: [candidate(request.itemId, "Discovered title")] },
  });
  const host = mount(<MetadataCandidateReview
    item={item("book-1", "Current")}
    onApplied={(value) => applied.push(value.id)}
    listCandidates={list}
    applyCandidate={async (request) => ({
      ok: true,
      value: {
        item: item(request.itemId, "Wrong success"),
        applied: {
          itemId: request.itemId,
          candidateId: "filename:other",
          source: request.candidate.source,
          provenance: request.provenance,
          fields: request.fields,
          coverApplied: request.cover,
        },
      },
    })}
  />);
  await act(async () => button(host, "Review").click());
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.click());
  await act(async () => button(host, "Apply selection").click());
  expect(applied).toEqual([]);
  expect(statusText(host)).toContain("did not match the selected candidate");
});

test("drops candidates provenance-bound to a different item and never applies them", async () => {
  const requests: string[] = [];
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: { itemId: request.itemId, candidates: [candidate("book-9", "Foreign title")] },
  });
  const apply: ApplyCandidate = async (request) => {
    requests.push(request.itemId);
    return { ok: false, error: { code: "protocol-error" } };
  };

  const host = mount(
    <MetadataCandidateReview
      item={item("book-1", "First")}
      onApplied={() => undefined}
      listCandidates={list}
      applyCandidate={apply}
    />,
  );
  await act(async () => {
    button(host, "Review").click();
  });

  expect(host.textContent).not.toContain("Foreign title");
  expect(statusText(host)).toContain("did not match the selected book");
  expect(requests).toEqual([]);
});

test("keyboard operation reaches review, selection, and apply controls", async () => {
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: { itemId: request.itemId, candidates: [candidate(request.itemId, "Discovered title")] },
  });
  const applied: string[] = [];

  const host = mount(
    <MetadataCandidateReview
      item={item("book-1", "First")}
      onApplied={(value) => applied.push(value.title)}
      listCandidates={list}
      applyCandidate={acceptingApply}
    />,
  );

  const review = button(host, "Review");
  review.focus();
  expect(document.activeElement).toBe(review);
  await act(async () => {
    review.click();
  });

  const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const fieldCheckbox = checkboxes[1];
  fieldCheckbox?.focus();
  expect(document.activeElement).toBe(fieldCheckbox as Element);
  await act(async () => {
    fieldCheckbox?.click();
  });

  const submit = button(host, "Apply selection");
  expect(submit.disabled).toBe(false);
  await act(async () => {
    submit.click();
  });

  expect(applied).toEqual(["Discovered title"]);
  const status = host.querySelector('[role="status"]');
  expect(status?.getAttribute("aria-live")).toBe("polite");
  expect(statusText(host)).toContain("Applied 1 metadata field");
});

test("shows path-free cover previews, leaves cover unchecked, and supports cover-only apply", async () => {
  const requests: Parameters<ApplyCandidate>[0][] = [];
  const list: ListCandidates = async (request) => ({
    ok: true,
    value: { itemId: request.itemId, candidates: [candidate(request.itemId, "Discovered title", true)] },
  });
  const host = mount(
    <MetadataCandidateReview
      item={{ ...item("book-1", "Current"), coverPath: "/managed/current.jpg" }}
      onApplied={() => undefined}
      listCandidates={list}
      applyCandidate={async (request) => { requests.push(request); return acceptingApply(request); }}
    />,
  );
  await act(async () => button(host, "Review").click());

  const candidateImage = host.querySelector<HTMLImageElement>('img[alt^="Candidate cover"]');
  expect(candidateImage?.getAttribute("src")).toBe("takio-cover://candidate/0123456789abcdef0123456789abcdef");
  expect(candidateImage?.getAttribute("src")).not.toContain("managed");
  const coverCheckbox = host.querySelector<HTMLInputElement>('input[aria-label^="Apply candidate cover"]')!;
  expect(coverCheckbox.checked).toBe(false);
  expect(button(host, "Apply selection").disabled).toBe(true);
  await act(async () => coverCheckbox.click());
  await act(async () => button(host, "Apply selection").click());

  expect(requests).toHaveLength(1);
  expect(requests[0]?.fields).toEqual([]);
  expect(requests[0]?.cover).toBe(true);
  expect(statusText(host)).toContain("Applied cover");
});
