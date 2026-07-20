import type { BookFormat, FormatId, LibraryItem } from "@takio/core";

import { resolveDeviceFormatPreference } from "./device-format-preference";

type BulkTagOperation = "add" | "remove" | "replace";

type LibraryItemLookupResult =
  | {
      readonly ok: true;
      readonly value: { readonly item: LibraryItem | null };
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string };
    };

type LibraryItemLookup = (id: string) => Promise<LibraryItemLookupResult>;

type LibrarySelectionHydrationOutcome =
  | { readonly status: "found"; readonly id: string; readonly item: LibraryItem }
  | { readonly status: "missing"; readonly id: string }
  | { readonly status: "failed"; readonly id: string; readonly code: string };

type LibrarySelectionHydration = {
  readonly outcomes: readonly LibrarySelectionHydrationOutcome[];
  readonly counts: {
    readonly total: number;
    readonly found: number;
    readonly missing: number;
    readonly failed: number;
  };
};

type BulkConversionPlanEntry =
  | {
      readonly status: "eligible";
      readonly item: LibraryItem;
      readonly source: BookFormat;
      readonly target: "pdf";
    }
  | {
      readonly status: "skipped";
      readonly item: LibraryItem;
      readonly reason: "pdf-already-attached" | "epub-source-unavailable";
    };

type BulkDeviceSendPlanEntry =
  | {
      readonly status: "eligible";
      readonly item: LibraryItem;
      readonly bookFormat: BookFormat;
    }
  | {
      readonly status: "convertible";
      readonly item: LibraryItem;
      readonly source: BookFormat;
      readonly target: FormatId;
    }
  | {
      readonly status: "unavailable";
      readonly item: LibraryItem;
      readonly preferred: FormatId;
    };

function normalizedTags(tags: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const display = tag.trim().replace(/\s+/g, " ");
    const comparison = display.toLowerCase();
    if (display.length === 0 || seen.has(comparison)) {
      continue;
    }
    seen.add(comparison);
    normalized.push(display);
  }

  return normalized;
}

export function applyBulkTagOperation(
  currentTags: readonly string[],
  operation: BulkTagOperation,
  requestedTags: readonly string[],
): readonly string[] {
  const current = normalizedTags(currentTags);
  const requested = normalizedTags(requestedTags);

  switch (operation) {
    case "add": {
      const existing = new Set(current.map((tag) => tag.toLowerCase()));
      return [
        ...current,
        ...requested.filter((tag) => {
          const comparison = tag.toLowerCase();
          if (existing.has(comparison)) {
            return false;
          }
          existing.add(comparison);
          return true;
        }),
      ];
    }
    case "remove": {
      const removed = new Set(requested.map((tag) => tag.toLowerCase()));
      return current.filter((tag) => !removed.has(tag.toLowerCase()));
    }
    case "replace":
      return requested;
  }
}

export async function hydrateSelectedLibraryItems(
  selectedIds: readonly string[],
  getById: LibraryItemLookup,
): Promise<LibrarySelectionHydration> {
  const outcomes: LibrarySelectionHydrationOutcome[] = [];

  for (const id of selectedIds) {
    try {
      const result = await getById(id);
      if (!result.ok) {
        outcomes.push({ status: "failed", id, code: result.error.code });
      } else if (result.value.item === null) {
        outcomes.push({ status: "missing", id });
      } else {
        outcomes.push({ status: "found", id, item: result.value.item });
      }
    } catch {
      outcomes.push({ status: "failed", id, code: "lookup-threw" });
    }
  }

  return {
    outcomes,
    counts: {
      total: outcomes.length,
      found: outcomes.filter(({ status }) => status === "found").length,
      missing: outcomes.filter(({ status }) => status === "missing").length,
      failed: outcomes.filter(({ status }) => status === "failed").length,
    },
  };
}

export function planBulkPdfConversion(
  items: readonly LibraryItem[],
): readonly BulkConversionPlanEntry[] {
  return items.map((item) => {
    if (item.formats.some(({ format }) => format === "pdf")) {
      return { status: "skipped", item, reason: "pdf-already-attached" };
    }

    const source = item.formats.find(({ format }) => format === "epub");
    return source
      ? { status: "eligible", item, source, target: "pdf" }
      : { status: "skipped", item, reason: "epub-source-unavailable" };
  });
}

export function planBulkDeviceSend(
  items: readonly LibraryItem[],
  preferred: FormatId,
): readonly BulkDeviceSendPlanEntry[] {
  return items.map((item) => {
    const resolution = resolveDeviceFormatPreference(item.formats, preferred);
    switch (resolution.kind) {
      case "attached":
        return { status: "eligible", item, bookFormat: resolution.bookFormat };
      case "convertible":
        return {
          status: "convertible",
          item,
          source: resolution.source,
          target: resolution.target,
        };
      case "unavailable":
        return { status: "unavailable", item, preferred: resolution.preferred };
    }
  });
}
