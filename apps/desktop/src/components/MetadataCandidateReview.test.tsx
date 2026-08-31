import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MetadataCandidateReview } from "./MetadataCandidateReview";

const item = {
  id: "book-1",
  title: "Current title",
  sourcePath: "/Books/book.epub",
  format: "epub",
  addedAt: "2026-08-30T20:00:00.000Z",
  formats: [{
    sourcePath: "/Books/book.epub",
    format: "epub",
    addedAt: "2026-08-30T20:00:00.000Z",
    provenance: "managed",
  }],
  tags: [],
} as const;

test("starts as an explicit, keyboard-operable candidate review surface", () => {
  const markup = renderToStaticMarkup(
    <MetadataCandidateReview item={item} onApplied={() => undefined} />,
  );

  expect(markup).toContain('aria-labelledby="metadata-candidate-heading"');
  expect(markup).toContain("Metadata candidates");
  expect(markup).toContain('<button type="button">Review</button>');
  expect(markup).toContain('type="checkbox"');
  expect(markup).toContain("Include online provider");
  expect(markup).toContain("Nothing is changed until you select fields and apply them.");
  expect(markup).toContain('role="status"');
  expect(markup).toContain('aria-live="polite"');
  expect(markup).not.toContain("Apply selection");
  expect(markup).not.toContain("cover");
});

test("disables candidate discovery while library actions are unavailable", () => {
  const markup = renderToStaticMarkup(
    <MetadataCandidateReview disabled item={item} onApplied={() => undefined} />,
  );
  expect(markup).toContain('<button type="button" disabled="">Review</button>');
  expect(markup).toContain('type="checkbox" disabled=""');
});
