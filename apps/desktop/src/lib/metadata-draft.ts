import {
  libraryMetadataPatchSchema,
  METADATA_CANDIDATE_AUDIT_KEY,
  type LibraryMetadataPatch,
} from "@takio/library-contract";
import type { LibraryItem } from "@takio/core";

export type MetadataDraftField<T> = Readonly<{
  state: "unchanged" | "concrete";
  value: T;
}>;

export type ClearableMetadataDraftField<T> = Readonly<{
  state: "unchanged" | "clear" | "concrete";
  value: T;
}>;

export type AuthorDraft = Readonly<{
  name: string;
  sortName: string;
}>;

export type IdentifierDraft = Readonly<{
  type: string;
  value: string;
}>;

export type CustomMetadataDraft = Readonly<{
  key: string;
  value: string;
}>;

export type MetadataDraft = Readonly<{
  title: MetadataDraftField<string>;
  authors: ClearableMetadataDraftField<readonly AuthorDraft[]>;
  series: ClearableMetadataDraftField<string>;
  seriesIndex: ClearableMetadataDraftField<string>;
  publisher: ClearableMetadataDraftField<string>;
  languages: ClearableMetadataDraftField<readonly string[]>;
  identifiers: ClearableMetadataDraftField<readonly IdentifierDraft[]>;
  customMetadata: ClearableMetadataDraftField<readonly CustomMetadataDraft[]>;
  publishedDate: ClearableMetadataDraftField<string>;
  rating: ClearableMetadataDraftField<string>;
  description: ClearableMetadataDraftField<string>;
  tags: MetadataDraftField<readonly string[]>;
}>;

export type MetadataDraftParseResult =
  | Readonly<{ ok: true; patch: LibraryMetadataPatch }>
  | Readonly<{
      ok: false;
      fieldErrors: Readonly<Record<string, string>>;
      summary: string;
    }>;

const decimalNumberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const customMetadataKeyPattern = /^[a-z][a-z0-9_]{0,63}$/;
const maxCustomMetadataValueLength = 16 * 1024;

export function draftFor(item: LibraryItem): MetadataDraft {
  const authors =
    item.authors ?? (item.author === undefined ? [] : [{ name: item.author }]);

  return {
    title: { state: "unchanged", value: item.title },
    authors: {
      state: "unchanged",
      value: authors.map((author) => ({
        name: author.name,
        sortName: author.sortName ?? "",
      })),
    },
    series: { state: "unchanged", value: item.series ?? "" },
    seriesIndex: {
      state: "unchanged",
      value: item.seriesIndex?.toString() ?? "",
    },
    publisher: { state: "unchanged", value: item.publisher ?? "" },
    languages: { state: "unchanged", value: [...(item.languages ?? [])] },
    identifiers: {
      state: "unchanged",
      value: Object.entries(item.identifiers ?? {}).map(([type, value]) => ({
        type,
        value,
      })),
    },
    customMetadata: {
      state: "unchanged",
      value: Object.entries(item.customMetadata ?? {})
        .filter(([key]) => key !== METADATA_CANDIDATE_AUDIT_KEY)
        .map(([key, value]) => ({ key, value })),
    },
    publishedDate: { state: "unchanged", value: item.publishedDate ?? "" },
    rating: { state: "unchanged", value: item.rating?.toString() ?? "" },
    description: { state: "unchanged", value: item.description ?? "" },
    tags: { state: "unchanged", value: [...item.tags] },
  };
}

function summaryFor(fieldErrors: Readonly<Record<string, string>>): string {
  const count = Object.keys(fieldErrors).length;
  return `Correct ${count} metadata ${count === 1 ? "field" : "fields"} before saving.`;
}

function messageForContractIssue(path: readonly PropertyKey[], fallback: string): string {
  const field = path[0];
  if (field === "title") return "Enter a title.";
  if (field === "authors") {
    return path.length === 1
      ? "Add at least one author or choose Clear."
      : "Enter an author name.";
  }
  if (field === "languages") {
    return path.length === 1
      ? "Add at least one language or choose Clear."
      : "Enter a valid language tag, such as en or en-US.";
  }
  if (field === "customMetadata") {
    return path.length === 1
      ? "Add no more than 64 custom fields or choose Clear."
      : path[2] === "key"
        ? "Use a lowercase key starting with a letter, followed by letters, numbers, or underscores (64 characters maximum)."
        : "Enter a value no larger than 16 KiB.";
  }
  if (field === "publishedDate") {
    return "Enter a valid date as YYYY, YYYY-MM, or YYYY-MM-DD.";
  }
  if (field === "rating") return "Enter a rating from 0 to 10.";
  if (field === "tags" && typeof path[1] === "number") {
    return fallback.includes("unique")
      ? "Tags must be unique ignoring case."
      : "Enter a tag.";
  }
  if (
    field === "series" ||
    field === "publisher" ||
    field === "description"
  ) {
    return "Enter a value or choose Clear.";
  }
  return fallback;
}

export function parseMetadataDraft(draft: MetadataDraft): MetadataDraftParseResult {
  const candidate: Record<string, unknown> = { tags: [...draft.tags.value] };
  const fieldErrors: Record<string, string> = {};

  const addError = (field: string, message: string): void => {
    fieldErrors[field] ??= message;
  };
  const assignText = (
    field: string,
    value: ClearableMetadataDraftField<string>,
  ): void => {
    if (value.state === "clear") candidate[field] = null;
    if (value.state === "concrete") candidate[field] = value.value;
  };
  const assignNumber = (
    field: "seriesIndex" | "rating",
    value: ClearableMetadataDraftField<string>,
  ): void => {
    if (value.state === "clear") {
      candidate[field] = null;
      return;
    }
    if (value.state !== "concrete") return;
    if (!decimalNumberPattern.test(value.value)) {
      addError(field, "Enter a finite decimal number or choose Clear.");
      return;
    }
    const parsed = Number(value.value);
    if (!Number.isFinite(parsed)) {
      addError(field, "Enter a finite decimal number or choose Clear.");
      return;
    }
    candidate[field] = parsed;
  };

  if (draft.title.state === "concrete") candidate.title = draft.title.value;

  if (draft.authors.state === "clear") {
    candidate.authors = null;
    candidate.author = null;
  } else if (draft.authors.state === "concrete") {
    const authors = draft.authors.value.map(({ name, sortName }) => {
      const trimmedSortName = sortName.trim();
      return {
        name: name.trim(),
        ...(trimmedSortName.length > 0 ? { sortName: trimmedSortName } : {}),
      };
    });
    candidate.authors = authors;
    if (authors[0]?.name) candidate.author = authors[0].name;
  }

  assignText("series", draft.series);
  assignNumber("seriesIndex", draft.seriesIndex);
  assignText("publisher", draft.publisher);

  if (draft.languages.state === "clear") {
    candidate.languages = null;
  } else if (draft.languages.state === "concrete") {
    candidate.languages = [...draft.languages.value];
  }

  if (draft.identifiers.state === "clear") {
    candidate.identifiers = null;
  } else if (draft.identifiers.state === "concrete") {
    const identifiers: Record<string, string> = {};
    const seenTypes = new Set<string>();
    for (const [index, identifier] of draft.identifiers.value.entries()) {
      const type = identifier.type.trim();
      const value = identifier.value.trim();
      if (type.length === 0) {
        addError(`identifiers.${index}.type`, "Enter an identifier type.");
      } else if (seenTypes.has(type)) {
        addError(
          `identifiers.${index}.type`,
          `Identifier type “${type}” is already present.`,
        );
      } else {
        seenTypes.add(type);
      }
      if (value.length === 0) {
        addError(`identifiers.${index}.value`, "Enter an identifier value.");
      }
      if (type.length > 0 && value.length > 0 && !Object.hasOwn(identifiers, type)) {
        identifiers[type] = value;
      }
    }
    candidate.identifiers = identifiers;
  }

  if (draft.customMetadata.state === "clear") {
    candidate.customMetadata = null;
  } else if (draft.customMetadata.state === "concrete") {
    const customMetadata: Record<string, string> = {};
    const seenKeys = new Set<string>();
    if (draft.customMetadata.value.length > 64) {
      addError("customMetadata", "Add no more than 64 custom fields or choose Clear.");
    }
    for (const [index, field] of draft.customMetadata.value.entries()) {
      const key = field.key.trim();
      if (!customMetadataKeyPattern.test(key)) {
        addError(
          `customMetadata.${index}.key`,
          "Use a lowercase key starting with a letter, followed by letters, numbers, or underscores (64 characters maximum).",
        );
      } else if (key === METADATA_CANDIDATE_AUDIT_KEY) {
        addError(
          `customMetadata.${index}.key`,
          "This key is reserved for Takio and cannot be edited.",
        );
      } else if (seenKeys.has(key)) {
        addError(
          `customMetadata.${index}.key`,
          `Custom field key “${key}” is already present.`,
        );
      } else {
        seenKeys.add(key);
      }
      if (field.value.length > maxCustomMetadataValueLength) {
        addError(`customMetadata.${index}.value`, "Enter a value no larger than 16 KiB.");
      }
      if (key.length > 0 && !Object.hasOwn(customMetadata, key)) {
        customMetadata[key] = field.value;
      }
    }
    candidate.customMetadata = customMetadata;
  }

  assignText("publishedDate", draft.publishedDate);
  assignNumber("rating", draft.rating);
  assignText("description", draft.description);

  const parsed = libraryMetadataPatchSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      addError(
        issue.path.join(".") || "form",
        messageForContractIssue(issue.path, issue.message),
      );
    }
    if (Object.keys(fieldErrors).length === 0) {
      addError("form", "Review the metadata values before saving.");
    }
    return { ok: false, fieldErrors, summary: summaryFor(fieldErrors) };
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, summary: summaryFor(fieldErrors) };
  }

  return { ok: true, patch: parsed.data };
}
