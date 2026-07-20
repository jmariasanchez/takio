import { expect, test } from "bun:test";
import type { LibraryItem } from "@takio/core";
import {
  mergeDuplicatePairRequestSchema,
  type DuplicateCandidate,
} from "@takio/library-contract";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryDuplicateReviewDialog,
  buildDuplicateMergeRequest,
  duplicateDialogFocusTarget,
  duplicatePageRange,
  duplicatePageTarget,
  duplicatePairReviewRequest,
} from "./LibraryDuplicateReviewDialog";

const left = {
  id: "book-1",
  title: "The Left Hand of Darkness",
  sourcePath: "/Books/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-18T12:00:00.000Z",
  formats: [
    {
      sourcePath: "/Books/left-hand.epub",
      format: "epub",
      addedAt: "2026-07-18T12:00:00.000Z",
      provenance: "managed",
    },
  ],
  authors: [{ name: "Ursula K. Le Guin" }],
  publisher: "Ace",
  languages: ["en"],
  identifiers: { isbn: "9780441478125" },
  publishedDate: "1969",
  rating: 9,
  coverPath: "/Books/left-hand.jpg",
  tags: ["Science fiction"],
} as const satisfies LibraryItem;

const right = {
  id: "book-2",
  title: "Left Hand of Darkness",
  sourcePath: "/Imports/left-hand.epub",
  format: "epub",
  addedAt: "2026-07-19T12:00:00.000Z",
  formats: [
    {
      sourcePath: "/Imports/left-hand.epub",
      format: "epub",
      addedAt: "2026-07-19T12:00:00.000Z",
      provenance: "referenced",
    },
    {
      sourcePath: "/Imports/left-hand.pdf",
      format: "pdf",
      addedAt: "2026-07-19T12:00:00.000Z",
      provenance: "managed",
    },
  ],
  author: "U. K. Le Guin",
  series: "Hainish Cycle",
  seriesIndex: 4,
  languages: ["en-US"],
  identifiers: { isbn: "9780441007318" },
  description: "An envoy visits a world without fixed gender.",
  coverPath: "/Imports/left-hand.png",
  tags: ["Classic", "Science fiction"],
} as const satisfies LibraryItem;

const candidate = {
  left,
  right,
  signals: [
    {
      kind: "same-content",
      leftFormat: "epub",
      rightFormat: "epub",
      bytes: 42,
      sha256: "b".repeat(64),
    },
    { kind: "same-identifier", scheme: "isbn", value: "9780441478125" },
    {
      kind: "same-title-author",
      title: "the left hand of darkness",
      author: "ursula k. le guin",
    },
  ],
  reviewToken: "a".repeat(64),
} as const satisfies DuplicateCandidate;

function render(
  overrides: Partial<Parameters<typeof LibraryDuplicateReviewDialog>[0]> = {},
): string {
  return renderToStaticMarkup(
    <LibraryDuplicateReviewDialog
      open
      candidates={[candidate]}
      total={21}
      pageOffset={0}
      pageLimit={20}
      disposition="unreviewed"
      loading={false}
      pendingReviewToken={null}
      pendingAction={null}
      staleReviewToken={null}
      error={null}
      onClose={() => undefined}
      onChangePage={() => undefined}
      onKeepSeparate={() => undefined}
      onReopen={() => undefined}
      onMerge={() => undefined}
      {...overrides}
    />,
  );
}

test("renders an accessible paged modal with explicit left/right evidence", () => {
  const markup = render();
  const titleId = markup.match(/aria-labelledby="([^"]+)"/)?.[1];

  expect(titleId).toBeDefined();
  expect(markup).toContain(`role="dialog" aria-modal="true" aria-labelledby="${titleId}"`);
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain(`<h2 id="${titleId}">Review duplicates</h2>`);
  expect(markup).toContain('aria-label="Left book: The Left Hand of Darkness"');
  expect(markup).toContain('aria-label="Right book: Left Hand of Darkness"');
  expect(markup).toContain("Ursula K. Le Guin");
  expect(markup).toContain("Hainish Cycle #4");
  expect(markup).toContain("isbn: 9780441478125");
  expect(markup).toContain("/Imports/left-hand.pdf");
  expect(markup).toContain("Same file content");
  expect(markup).toContain(`SHA-256 ${"b".repeat(64)}`);
  expect(markup).toContain("Same identifier");
  expect(markup).toContain("Same title and author");
  expect(markup).toContain('<nav aria-label="Duplicate candidate pages">');
  expect(markup).toContain("1–1 of 21");
  expect(markup).not.toMatch(/reader|viewer|open book/i);
});

test("renders every explicit merge choice and a destructive confirmation", () => {
  const markup = render();

  expect(markup).toContain("1. Choose the book to keep");
  expect(markup).toContain("Keep left · The Left Hand of Darkness");
  expect(markup).toContain("Keep right · Left Hand of Darkness");
  expect(markup).toContain("2. Metadata");
  expect(markup).toContain("Keep target metadata");
  expect(markup).toContain("Replace with source metadata");
  expect(markup).toContain("3. Add formats from the source");
  expect(markup).toContain("Add PDF");
  expect(markup).toContain("4. Cover");
  expect(markup).toContain("Keep target cover");
  expect(markup).toContain("Use source cover");
  expect(markup).toContain("Remove cover");
  expect(markup).toContain("Keep separate");
  expect(markup).toContain("Review merge");
  expect(markup).toContain('aria-label="Confirm merge into The Left Hand of Darkness" hidden="" inert=""');
  expect(markup).toContain("Merge and move source to Trash");
});

test("builds exact schema-valid merge and disposition requests", () => {
  expect(duplicatePairReviewRequest(candidate)).toEqual({
    leftId: "book-1",
    rightId: "book-2",
    reviewToken: "a".repeat(64),
  });

  const keepLeft = buildDuplicateMergeRequest(
    candidate,
    left.id,
    "target",
    ["pdf"],
    "target",
  );
  expect(keepLeft).toEqual({
    targetId: "book-1",
    sourceId: "book-2",
    reviewToken: "a".repeat(64),
    metadata: { tags: ["Science fiction"] },
    addSourceFormats: ["pdf"],
    cover: "target",
  });
  expect(mergeDuplicatePairRequestSchema.parse(keepLeft)).toEqual(keepLeft);

  const keepRightWithLeftMetadata = buildDuplicateMergeRequest(
    candidate,
    right.id,
    "source",
    [],
    "source",
  );
  expect(keepRightWithLeftMetadata).toEqual({
    targetId: "book-2",
    sourceId: "book-1",
    reviewToken: "a".repeat(64),
    metadata: {
      title: "The Left Hand of Darkness",
      author: null,
      authors: [{ name: "Ursula K. Le Guin" }],
      series: null,
      seriesIndex: null,
      publisher: "Ace",
      languages: ["en"],
      identifiers: { isbn: "9780441478125" },
      publishedDate: "1969",
      rating: 9,
      description: null,
      tags: ["Science fiction"],
    },
    addSourceFormats: [],
    cover: "source",
  });
  expect(mergeDuplicatePairRequestSchema.parse(keepRightWithLeftMetadata)).toEqual(
    keepRightWithLeftMetadata,
  );
});

test("rejects merge choices that cannot describe this pair", () => {
  expect(() => buildDuplicateMergeRequest(candidate, "not-in-pair", "target", [], "none")).toThrow();
  expect(() => buildDuplicateMergeRequest(candidate, left.id, "target", ["epub"], "target")).toThrow();
  expect(() => buildDuplicateMergeRequest(candidate, left.id, "target", ["pdf", "pdf"], "target")).toThrow();

  const withoutSourceCover = {
    ...candidate,
    right: { ...candidate.right, coverPath: undefined },
  };
  expect(() => buildDuplicateMergeRequest(withoutSourceCover, left.id, "target", [], "source")).toThrow();
});

test("shows kept, pending, stale, error, empty, and closed states", () => {
  const keptMarkup = render({ disposition: "kept-both" });
  const pendingMarkup = render({
    pendingReviewToken: candidate.reviewToken,
    pendingAction: "merge",
  });
  const staleMarkup = render({
    staleReviewToken: candidate.reviewToken,
    error: "Evidence no longer matches this pair.",
  });
  const emptyMarkup = render({ candidates: [], total: 0 });

  expect(keptMarkup).toContain("Reopen review");
  expect(keptMarkup).not.toContain("Review merge");
  expect(pendingMarkup).toContain('aria-busy="true"');
  expect(pendingMarkup).toContain("Merging duplicate pair…");
  expect(staleMarkup).toContain("Evidence changed");
  expect(staleMarkup).toContain("This pair changed after it was reviewed.");
  expect(staleMarkup).toContain('role="alert">Evidence no longer matches this pair.</p>');
  expect(emptyMarkup).toContain("No duplicates need review");
  expect(emptyMarkup).toContain("0 of 0");
  expect(render({ open: false })).toBe("");
});

test("wraps focus and computes bounded duplicate pages", () => {
  expect(duplicateDialogFocusTarget(0, 4, true)).toBe(3);
  expect(duplicateDialogFocusTarget(3, 4, false)).toBe(0);
  expect(duplicateDialogFocusTarget(1, 4, false)).toBeNull();
  expect(duplicateDialogFocusTarget(-1, 4, false)).toBe(0);
  expect(duplicateDialogFocusTarget(-1, 4, true)).toBe(3);
  expect(duplicateDialogFocusTarget(0, 0, false)).toBeNull();

  expect(duplicatePageRange(20, 2, 42)).toEqual({ start: 21, end: 22 });
  expect(duplicatePageRange(0, 0, 0)).toEqual({ start: 0, end: 0 });
  expect(duplicatePageTarget("previous", 20, 20, 42)).toBe(0);
  expect(duplicatePageTarget("previous", 0, 20, 42)).toBeNull();
  expect(duplicatePageTarget("next", 20, 20, 42)).toBe(40);
  expect(duplicatePageTarget("next", 40, 20, 42)).toBeNull();
  expect(duplicatePageTarget("next", 0, 0, 42)).toBeNull();
});
