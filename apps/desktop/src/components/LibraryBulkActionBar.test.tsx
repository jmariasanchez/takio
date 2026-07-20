import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LibraryBulkActionBar,
  type LibraryBulkActionBarProps,
} from "./LibraryBulkActionBar";

type ActionElement = ReactElement<{
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}>;

function elements(node: ReactNode): ActionElement[] {
  if (!isValidElement(node)) {
    return [];
  }

  const element = node as ActionElement;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}

function props(
  overrides: Partial<LibraryBulkActionBarProps> = {},
): LibraryBulkActionBarProps {
  return {
    selectedCount: 3,
    disabled: false,
    pendingAction: null,
    canConvert: true,
    canSend: true,
    onExport: () => undefined,
    onEditTags: () => undefined,
    onEditMetadata: () => undefined,
    onConvert: () => undefined,
    onSend: () => undefined,
    onMoveToTrash: () => undefined,
    onClear: () => undefined,
    ...overrides,
  };
}

test("renders only for a positive selection and announces its exact count", () => {
  expect(renderToStaticMarkup(<LibraryBulkActionBar {...props({ selectedCount: 0 })} />)).toBe(
    "",
  );
  expect(
    renderToStaticMarkup(<LibraryBulkActionBar {...props({ selectedCount: -1 })} />),
  ).toBe("");

  const singular = renderToStaticMarkup(
    <LibraryBulkActionBar {...props({ selectedCount: 1 })} />,
  );
  const plural = renderToStaticMarkup(
    <LibraryBulkActionBar {...props({ selectedCount: 12 })} />,
  );

  expect(singular).toContain('aria-label="Bulk actions" aria-busy="false"');
  expect(singular).toContain(
    'role="status" aria-live="polite" aria-atomic="true"><strong>1 book selected</strong>',
  );
  expect(plural).toContain("<strong>12 books selected</strong>");
});

test("offers only the requested bulk library actions without introducing a reading surface", () => {
  const markup = renderToStaticMarkup(<LibraryBulkActionBar {...props()} />);

  for (const label of [
    "Save to disk…",
    "Edit tags",
    "Edit metadata…",
    "Convert",
    "Send",
    "Move to Trash",
    "Clear selection",
  ]) {
    expect(markup).toContain(`>${label}</button>`);
  }
  expect(markup).toContain('title="Copy every attached format to a folder"');
  expect(markup.match(/<button/g)).toHaveLength(7);
  expect(markup).not.toMatch(/reader|viewer|open book/i);
});

test("disables conversion and sending independently when the selection is ineligible", () => {
  const tree = LibraryBulkActionBar(
    props({ canConvert: false, canSend: true }),
  );
  const buttons = elements(tree).filter((element) => element.type === "button");

  expect(buttons.find(({ props }) => props.children === "Edit tags")?.props.disabled).toBe(
    false,
  );
  expect(
    buttons.find(({ props }) => props.children === "Edit metadata…")?.props.disabled,
  ).toBe(false);
  expect(buttons.find(({ props }) => props.children === "Convert")?.props.disabled).toBe(
    true,
  );
  expect(buttons.find(({ props }) => props.children === "Send")?.props.disabled).toBe(
    false,
  );
  expect(
    buttons.find(({ props }) => props.children === "Move to Trash")?.props.disabled,
  ).toBe(false);
  expect(
    buttons.find(({ props }) => props.children === "Clear selection")?.props.disabled,
  ).toBe(false);

  const markup = renderToStaticMarkup(tree);
  expect(markup).toContain('title="Conversion is not available for this selection"');
  expect(markup).not.toContain('title="Sending is not available for this selection"');
});

test("announces pending work and disables every control so the target cannot change mid-action", () => {
  const tree = LibraryBulkActionBar(props({ pendingAction: "export" }));
  const buttons = elements(tree).filter((element) => element.type === "button");
  const markup = renderToStaticMarkup(tree);

  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain("Saving to disk…");
  expect(buttons).toHaveLength(7);
  expect(buttons.every(({ props }) => props.disabled)).toBe(true);
});

test("globally disables every control while unrelated library work is pending", () => {
  const tree = LibraryBulkActionBar(props({ disabled: true }));
  const buttons = elements(tree).filter((element) => element.type === "button");
  const markup = renderToStaticMarkup(tree);

  expect(markup).toContain('aria-busy="false"');
  expect(markup).not.toContain("Updating tags…");
  expect(buttons).toHaveLength(7);
  expect(buttons.every(({ props }) => props.disabled)).toBe(true);
});

test("emits each controlled action exactly once while enabled", () => {
  const calls: string[] = [];
  const tree = LibraryBulkActionBar(
    props({
      onExport: () => calls.push("export"),
      onEditTags: () => calls.push("tags"),
      onEditMetadata: () => calls.push("metadata"),
      onConvert: () => calls.push("convert"),
      onSend: () => calls.push("send"),
      onMoveToTrash: () => calls.push("trash"),
      onClear: () => calls.push("clear"),
    }),
  );
  const buttons = elements(tree).filter((element) => element.type === "button");

  for (const button of buttons) {
    button.props.onClick?.();
  }

  expect(calls).toEqual([
    "export",
    "tags",
    "metadata",
    "convert",
    "send",
    "trash",
    "clear",
  ]);
});
