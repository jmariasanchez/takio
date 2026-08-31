import { expect, test } from "bun:test";
import type { LibraryMetadataPatch } from "@takio/library-contract";
import type { LibraryItem } from "@takio/core";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { draftFor, type MetadataDraft } from "../lib/metadata-draft";
import { MetadataEditor, type MetadataEditorProps } from "./MetadataEditor";

type InteractiveElement = ReactElement<{
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
  readonly onClick?: () => void;
  readonly onSubmit?: (event: { preventDefault: () => void }) => void;
  readonly stateControl?: ReactNode;
}>;

type ChangeControl = ReactElement<{
  readonly onChange?: (state: "unchanged" | "clear" | "concrete") => void;
}>;

function elements(node: ReactNode): InteractiveElement[] {
  if (!isValidElement(node)) return [];
  const element = node as InteractiveElement;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}

const item = {
  id: "item-1",
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
  author: "Ursula K. Le Guin",
  authors: [
    { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." },
    { name: "Second Author", sortName: "Author, Second" },
  ],
  series: "Hainish Cycle",
  seriesIndex: 4.5,
  publisher: "Ace Books",
  languages: ["en-US", "fr"],
  identifiers: { isbn: "9780441478125", asin: "B00YBA7PGW" },
  publishedDate: "1969-03",
  rating: 8.5,
  description: "A novel of exile, identity, and trust.",
  tags: ["Science fiction", "Classic"],
  customMetadata: {
    shelf: "Favorites",
    takio_metadata_audit: "reserved audit",
  },
} as const satisfies LibraryItem;

function props(overrides: Partial<MetadataEditorProps> = {}): MetadataEditorProps {
  return {
    draft: draftFor(item),
    idPrefix: "book-edit",
    onCancel: () => undefined,
    onChange: () => undefined,
    onSave: () => undefined,
    ...overrides,
  };
}

function concreteDraft(): MetadataDraft {
  const draft = draftFor(item);
  return {
    title: { ...draft.title, state: "concrete" },
    authors: { ...draft.authors, state: "concrete" },
    series: { ...draft.series, state: "concrete" },
    seriesIndex: { ...draft.seriesIndex, state: "concrete" },
    publisher: { ...draft.publisher, state: "concrete" },
    languages: { ...draft.languages, state: "concrete" },
    identifiers: { ...draft.identifiers, state: "concrete" },
    customMetadata: { ...draft.customMetadata, state: "concrete" },
    publishedDate: { ...draft.publishedDate, state: "concrete" },
    rating: { ...draft.rating, state: "concrete" },
    description: { ...draft.description, state: "concrete" },
    tags: { ...draft.tags, state: "concrete" },
  };
}

test("renders the complete dense metadata contract without a reading surface", () => {
  const markup = renderToStaticMarkup(<MetadataEditor {...props()} />);
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

  expect(markup).toContain("Edit metadata");
  for (const section of [
    "Basic",
    "Contributors",
    "Publication",
    "Classification and identifiers",
    "Notes",
    "Custom fields",
  ]) {
    expect(markup).toContain(`<legend>${section}</legend>`);
  }
  for (const field of [
    "Title",
    "Authors",
    "Sort name",
    "Series index",
    "Publisher",
    "Languages",
    "Identifiers",
    "Published date",
    "Rating",
    "Description",
    "Tags",
    "Custom fields",
  ]) {
    expect(markup).toContain(field);
  }
  expect(markup).toContain("Use YYYY, YYYY-MM, or YYYY-MM-DD.");
  expect(markup).toContain("Enter a number from 0 to 10.");
  expect(markup).toContain("An empty list clears all tags.");
  expect(markup).toContain("Up to 64 fields and 16 KiB per value.");
  expect(markup).toContain('aria-label="Custom field 1 key"');
  expect(markup).not.toContain("takio_metadata_audit");
  expect(markup).toContain("Keep current");
  expect(markup).toContain("Replace");
  expect(markup).toContain("Clear");
  expect(markup).toContain('noValidate=""');
  expect(new Set(ids).size).toBe(ids.length);
  expect(markup).not.toContain("Reader");
});

test("labels defined fields while retaining undeclared legacy fields", () => {
  const markup = renderToStaticMarkup(
    <MetadataEditor
      {...props()}
      definitions={[{ key: "shelf", label: "Shelf", type: "text", position: 0 }]}
      draft={{
        ...draftFor(item),
        customMetadata: {
          state: "concrete",
          value: [
            { key: "shelf", value: "Favorites" },
            { key: "legacy_note", value: "Old data" },
          ],
        },
      }}
    />,
  );

  expect(markup).toContain("Shelf (#shelf)");
  expect(markup).toContain('aria-label="Shelf key, #shelf"');
  expect(markup).toContain("<span>Shelf value</span><textarea");
  expect(markup).not.toContain('aria-label="Custom field 1 value"');
  expect(markup).toContain('aria-label="Custom field 2 key"');
});

test("controlled collection and title actions emit exact concrete drafts", () => {
  const changes: MetadataDraft[] = [];
  const draft = concreteDraft();
  const controls = elements(
    MetadataEditor(props({ draft, onChange: (nextDraft) => changes.push(nextDraft) })),
  );

  controls
    .find((element) => element.props.id === "book-edit-title")
    ?.props.onChange?.({ currentTarget: { value: "A Wizard of Earthsea" } });
  controls
    .find((element) => element.props["aria-label"] === "Move author 2 up")
    ?.props.onClick?.();
  controls
    .find((element) => element.props.children === "Add author")
    ?.props.onClick?.();
  controls
    .find((element) => element.props["aria-label"] === "Remove language 1")
    ?.props.onClick?.();
  controls
    .find((element) => element.props["aria-label"] === "Tag 1")
    ?.props.onChange?.({ currentTarget: { value: "Speculative fiction" } });
  controls
    .find((element) => element.props["aria-label"] === "Custom field 1 value")
    ?.props.onChange?.({ currentTarget: { value: "To reread" } });
  controls
    .find((element) => element.props.children === "Add custom field")
    ?.props.onClick?.();
  controls
    .find((element) => element.props["aria-label"] === "Remove custom field 1")
    ?.props.onClick?.();
  const authorsStateControl = controls.find(
    (element) => element.props.children === "Authors" && element.props.stateControl,
  )?.props.stateControl;
  if (isValidElement(authorsStateControl)) {
    (authorsStateControl as ChangeControl).props.onChange?.("clear");
  }

  expect(changes).toHaveLength(9);
  expect(changes[0]?.title).toEqual({ state: "concrete", value: "A Wizard of Earthsea" });
  expect(changes[1]?.authors).toEqual({
    state: "concrete",
    value: [
      { name: "Second Author", sortName: "Author, Second" },
      { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." },
    ],
  });
  expect(changes[2]?.authors.value.at(-1)).toEqual({ name: "", sortName: "" });
  expect(changes[3]?.languages).toEqual({ state: "concrete", value: ["fr"] });
  expect(changes[4]?.tags).toEqual({
    state: "concrete",
    value: ["Speculative fiction", "Classic"],
  });
  expect(changes[5]?.customMetadata).toEqual({
    state: "concrete",
    value: [{ key: "shelf", value: "To reread" }],
  });
  expect(changes[6]?.customMetadata.value.at(-1)).toEqual({ key: "", value: "" });
  expect(changes[7]?.customMetadata).toEqual({ state: "concrete", value: [] });
  expect(changes[8]?.authors).toEqual({ state: "clear", value: draft.authors.value });
});

test("invalid fields render a focusable linked summary and block save", () => {
  const draft: MetadataDraft = {
    ...concreteDraft(),
    title: { state: "concrete", value: "   " },
    authors: { state: "concrete", value: [] },
    identifiers: {
      state: "concrete",
      value: [
        { type: "isbn", value: "one" },
        { type: "isbn", value: "two" },
      ],
    },
    customMetadata: {
      state: "concrete",
      value: [
        { key: "Bad Key", value: "one" },
        { key: "shelf", value: "two" },
        { key: "shelf", value: "three" },
      ],
    },
    rating: { state: "concrete", value: "11" },
  };
  const saves: LibraryMetadataPatch[] = [];
  const tree = MetadataEditor(props({ draft, onSave: (patch) => saves.push(patch) }));
  const markup = renderToStaticMarkup(tree);
  let prevented = false;

  elements(tree)
    .find((element) => element.type === "form")
    ?.props.onSubmit?.({ preventDefault: () => { prevented = true; } });

  expect(markup).toContain('role="alert"');
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain('href="#book-edit-title"');
  expect(markup).toContain('href="#book-edit-authors-change"');
  expect(markup).toContain('href="#book-edit-identifiers-1-type"');
  expect(markup).toContain('href="#book-edit-rating"');
  expect(markup).toContain('href="#book-edit-customMetadata-0-key"');
  expect(markup).toContain('href="#book-edit-customMetadata-2-key"');
  expect(markup).toContain('aria-invalid="true"');
  expect(markup).toContain("Enter a title.");
  expect(markup).toContain("Identifier type “isbn” is already present.");
  expect(markup).toContain("Custom field key “shelf” is already present.");
  expect(markup).toContain("Enter a rating from 0 to 10.");
  expect(prevented).toBe(true);
  expect(saves).toEqual([]);
});

test("custom field change control emits an explicit clear without exposing audit metadata", () => {
  const changes: MetadataDraft[] = [];
  const draft = draftFor(item);
  const controls = elements(
    MetadataEditor(props({ draft, onChange: (nextDraft) => changes.push(nextDraft) })),
  );
  const customStateControl = controls.find(
    (element) => element.props.children === "Custom fields" && element.props.stateControl,
  )?.props.stateControl;

  if (isValidElement(customStateControl)) {
    (customStateControl as ChangeControl).props.onChange?.("clear");
  }

  expect(changes).toEqual([
    {
      ...draft,
      customMetadata: { state: "clear", value: [{ key: "shelf", value: "Favorites" }] },
    },
  ]);
  expect(JSON.stringify(changes)).not.toContain("takio_metadata_audit");
});

test("save emits only the schema-validated patch with normalized author values", () => {
  const saves: LibraryMetadataPatch[] = [];
  const draft: MetadataDraft = {
    ...concreteDraft(),
    authors: {
      state: "concrete",
      value: [
        { name: "  Ursula K. Le Guin  ", sortName: "  Le Guin, Ursula K.  " },
        { name: "Second Author", sortName: "" },
      ],
    },
  };
  const tree = MetadataEditor(props({ draft, onSave: (patch) => saves.push(patch) }));
  let prevented = false;

  elements(tree)
    .find((element) => element.type === "form")
    ?.props.onSubmit?.({ preventDefault: () => { prevented = true; } });

  expect(prevented).toBe(true);
  expect(saves).toEqual([
    {
      title: "The Left Hand of Darkness",
      author: "Ursula K. Le Guin",
      authors: [
        { name: "Ursula K. Le Guin", sortName: "Le Guin, Ursula K." },
        { name: "Second Author" },
      ],
      series: "Hainish Cycle",
      seriesIndex: 4.5,
      publisher: "Ace Books",
      languages: ["en-US", "fr"],
      identifiers: { isbn: "9780441478125", asin: "B00YBA7PGW" },
      customMetadata: { shelf: "Favorites" },
      publishedDate: "1969-03",
      rating: 8.5,
      description: "A novel of exile, identity, and trust.",
      tags: ["Science fiction", "Classic"],
    },
  ]);
});

test("cancel is explicit and busy mode disables every form region", () => {
  let cancelled = false;
  const activeTree = MetadataEditor(props({ onCancel: () => { cancelled = true; } }));
  elements(activeTree)
    .find((element) => element.type === "button" && element.props.children === "Cancel")
    ?.props.onClick?.();
  expect(cancelled).toBe(true);

  const busyTree = MetadataEditor(props({ busy: true }));
  const busyControls = elements(busyTree);
  const markup = renderToStaticMarkup(busyTree);
  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain("Saving metadata…");
  expect(markup).toContain("Saving…");
  expect(
    busyControls.filter((element) => element.type === "fieldset").every(
      (element) => element.props.disabled,
    ),
  ).toBe(true);
  expect(
    busyControls.find(
      (element) => element.type === "button" && element.props.children === "Cancel",
    )?.props.disabled,
  ).toBe(true);
  expect(
    busyControls.find(
      (element) => element.type === "button" && element.props.children === "Saving…",
    )?.props.disabled,
  ).toBe(true);
});
