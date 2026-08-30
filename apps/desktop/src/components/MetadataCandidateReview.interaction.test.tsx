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

function candidate(itemId: string, title: string) {
  return {
    schemaVersion: 1,
    id: "filename:1",
    source: "filename",
    confidence: "medium",
    patch: { title },
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
    button(host, "Apply selected fields").click();
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
        },
      },
    });
    await Promise.resolve();
  });

  expect(applied).toEqual([]);
  expect(statusText(host)).toBe("");
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
  expect(statusText(host)).toContain("No metadata candidates were found.");
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

  const submit = button(host, "Apply selected fields");
  expect(submit.disabled).toBe(false);
  await act(async () => {
    submit.click();
  });

  expect(applied).toEqual(["Discovered title"]);
  const status = host.querySelector('[role="status"]');
  expect(status?.getAttribute("aria-live")).toBe("polite");
  expect(statusText(host)).toContain("Applied 1 selected field");
});
