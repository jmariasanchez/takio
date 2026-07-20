import {
  libraryMetadataPatchSchema,
  type LibraryMetadataPatch,
} from "@takio/library-contract";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import "./LibraryBulkMetadataDialog.css";

export type LibraryBulkMetadataField =
  | "publisher"
  | "series"
  | "seriesIndex"
  | "rating"
  | "languages";

export type LibraryBulkMetadataFieldMode = "unchanged" | "replace" | "clear";

export type LibraryBulkMetadataDraft = Readonly<
  Record<
    LibraryBulkMetadataField,
    Readonly<{ mode: LibraryBulkMetadataFieldMode; value: string }>
  >
>;

export type LibraryBulkMetadataValidation = Readonly<{
  patch: LibraryMetadataPatch | null;
  fieldErrors: Readonly<Partial<Record<LibraryBulkMetadataField, string>>>;
  error: string | null;
}>;

export type LibraryBulkMetadataDialogProps = {
  readonly open: boolean;
  readonly selectedCount: number;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onApply: (patch: LibraryMetadataPatch) => void;
};

type LibraryBulkMetadataFieldDefinition = Readonly<{
  key: LibraryBulkMetadataField;
  label: string;
  placeholder: string;
  help: string;
  inputMode?: "decimal";
}>;

const fields: readonly LibraryBulkMetadataFieldDefinition[] = [
  {
    key: "publisher",
    label: "Publisher",
    placeholder: "Ace Books",
    help: "Replaces the publisher on every selected book.",
  },
  {
    key: "series",
    label: "Series",
    placeholder: "Hainish Cycle",
    help: "Replaces the series on every selected book.",
  },
  {
    key: "seriesIndex",
    label: "Series index",
    placeholder: "4.5",
    help: "Enter a finite number.",
    inputMode: "decimal",
  },
  {
    key: "rating",
    label: "Rating",
    placeholder: "8.5",
    help: "Enter a number from 0 to 10.",
    inputMode: "decimal",
  },
  {
    key: "languages",
    label: "Languages",
    placeholder: "en-US, fr",
    help: "Use comma-separated language tags such as en, en-US, or fr.",
  },
];

const fieldLabels: Readonly<Record<LibraryBulkMetadataField, string>> = {
  publisher: "Publisher",
  series: "Series",
  seriesIndex: "Series index",
  rating: "Rating",
  languages: "Languages",
};

const decimalNumberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function emptyDraft(): LibraryBulkMetadataDraft {
  return {
    publisher: { mode: "unchanged", value: "" },
    series: { mode: "unchanged", value: "" },
    seriesIndex: { mode: "unchanged", value: "" },
    rating: { mode: "unchanged", value: "" },
    languages: { mode: "unchanged", value: "" },
  };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.closest('[hidden], [inert], [aria-hidden="true"]') === null,
  );
}

export function bulkMetadataDialogFocusTarget(
  currentIndex: number,
  itemCount: number,
  backwards: boolean,
): number | null {
  if (itemCount === 0) return null;
  if (currentIndex < 0) return backwards ? itemCount - 1 : 0;
  if (backwards && currentIndex === 0) return itemCount - 1;
  if (!backwards && currentIndex === itemCount - 1) return 0;
  return null;
}

function numberValue(
  value: string,
  field: "seriesIndex" | "rating",
  fieldErrors: Partial<Record<LibraryBulkMetadataField, string>>,
): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || !decimalNumberPattern.test(trimmed)) {
    fieldErrors[field] =
      field === "rating"
        ? "Enter a rating from 0 to 10 or choose Clear."
        : "Enter a finite series index or choose Clear.";
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    fieldErrors[field] =
      field === "rating"
        ? "Enter a rating from 0 to 10 or choose Clear."
        : "Enter a finite series index or choose Clear.";
    return null;
  }
  return parsed;
}

export function validateBulkLibraryMetadata(
  draft: LibraryBulkMetadataDraft,
): LibraryBulkMetadataValidation {
  const candidate: Record<string, unknown> = {};
  const fieldErrors: Partial<Record<LibraryBulkMetadataField, string>> = {};

  for (const field of fields) {
    const entry = draft[field.key];
    if (entry.mode === "unchanged") continue;
    if (entry.mode === "clear") {
      candidate[field.key] = null;
      continue;
    }

    if (field.key === "seriesIndex" || field.key === "rating") {
      const value = numberValue(entry.value, field.key, fieldErrors);
      if (value !== null) candidate[field.key] = value;
      continue;
    }

    if (field.key === "languages") {
      const values = entry.value.split(",").map((value) => value.trim());
      if (entry.value.trim() === "") {
        fieldErrors.languages = "Enter at least one language tag or choose Clear.";
      } else if (values.some((value) => value === "")) {
        fieldErrors.languages =
          "Enter comma-separated language tags without empty entries.";
      } else {
        candidate.languages = values;
      }
      continue;
    }

    candidate[field.key] = entry.value;
  }

  if (Object.keys(candidate).length === 0 && Object.keys(fieldErrors).length === 0) {
    return {
      patch: null,
      fieldErrors,
      error: "Choose at least one metadata field to replace or clear.",
    };
  }

  const result = libraryMetadataPatchSchema.safeParse(candidate);
  if (result.success) {
    if (Object.keys(fieldErrors).length > 0) {
      return {
        patch: null,
        fieldErrors,
        error: "Correct the highlighted metadata fields.",
      };
    }
    return { patch: result.data, fieldErrors, error: null };
  }

  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field !== "string" || !(field in fieldLabels)) continue;
    const key = field as LibraryBulkMetadataField;
    if (key === "rating") {
      fieldErrors.rating = "Enter a rating from 0 to 10 or choose Clear.";
    } else if (key === "languages") {
      fieldErrors.languages = "Use valid language tags such as en, en-US, or fr.";
    } else if (key === "seriesIndex") {
      fieldErrors.seriesIndex = "Enter a finite series index or choose Clear.";
    } else {
      fieldErrors[key] = `Enter a ${fieldLabels[key].toLowerCase()} or choose Clear.`;
    }
  }

  return {
    patch: null,
    fieldErrors,
    error: "Correct the highlighted metadata fields.",
  };
}

export function LibraryBulkMetadataDialog({
  open,
  selectedCount,
  pending,
  error,
  onClose,
  onApply,
}: LibraryBulkMetadataDialogProps) {
  const instanceId = useId();
  const titleId = `${instanceId}-title`;
  const descriptionId = `${instanceId}-description`;
  const statusId = `${instanceId}-status`;
  const errorId = `${instanceId}-error`;
  const dialogRef = useRef<HTMLElement>(null);
  const firstModeRef = useRef<HTMLSelectElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [draft, setDraft] = useState<LibraryBulkMetadataDraft>(emptyDraft);
  const [validation, setValidation] = useState<LibraryBulkMetadataValidation | null>(null);
  const visibleError = validation?.error ?? (error?.trim() || null);
  const selectionLabel = `${selectedCount} ${selectedCount === 1 ? "book" : "books"}`;
  const hasChanges = fields.some((field) => draft[field.key].mode !== "unchanged");

  useEffect(() => {
    const opening = open && !wasOpen.current;
    const closing = !open && wasOpen.current;
    wasOpen.current = open;

    if (opening) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDraft(emptyDraft());
      setValidation(null);
      const frame = window.requestAnimationFrame(() => firstModeRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }

    if (closing) {
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      const frame = window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    return;
  }, [open]);

  if (!open) return null;

  function updateField(
    field: LibraryBulkMetadataField,
    update: Partial<LibraryBulkMetadataDraft[LibraryBulkMetadataField]>,
  ): void {
    setDraft((current) => ({
      ...current,
      [field]: { ...current[field], ...update },
    }));
    setValidation(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) return;

    const result = validateBulkLibraryMetadata(draft);
    setValidation(result);
    if (result.patch !== null) onApply(result.patch);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex = bulkMetadataDialogFocusTarget(
      currentIndex,
      focusable.length,
      event.shiftKey,
    );
    if (targetIndex === null) return;
    event.preventDefault();
    focusable[targetIndex]?.focus();
  }

  return (
    <div className="library-bulk-metadata-dialog__overlay">
      <section
        ref={dialogRef}
        className="library-bulk-metadata-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId}${visibleError === null ? "" : ` ${errorId}`}`}
        aria-busy={pending}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <form noValidate onSubmit={handleSubmit}>
          <header className="library-bulk-metadata-dialog__header">
            <div>
              <span className="library-bulk-metadata-dialog__eyebrow">Bulk metadata</span>
              <h2 id={titleId}>Edit metadata</h2>
            </div>
            <button type="button" aria-label="Close metadata editor" onClick={onClose}>
              Close
            </button>
          </header>

          <div className="library-bulk-metadata-dialog__body">
            <p id={descriptionId} className="library-bulk-metadata-dialog__selection">
              Update metadata for <strong>{selectionLabel}</strong>. Unchanged fields keep each
              book&apos;s current value.
            </p>

            <div className="library-bulk-metadata-dialog__fields">
              {fields.map((field, index) => {
                const entry = draft[field.key];
                const modeId = `${instanceId}-${field.key}-mode`;
                const inputId = `${instanceId}-${field.key}`;
                const helpId = `${inputId}-help`;
                const fieldError = validation?.fieldErrors[field.key];
                const fieldErrorId = `${inputId}-error`;
                return (
                  <fieldset key={field.key} disabled={pending}>
                    <legend>{field.label}</legend>
                    <div className="library-bulk-metadata-dialog__field-grid">
                      <label htmlFor={modeId}>
                        <span>Change</span>
                        <select
                          ref={index === 0 ? firstModeRef : undefined}
                          id={modeId}
                          value={entry.mode}
                          aria-label={`${field.label} change`}
                          onChange={(event) =>
                            updateField(field.key, {
                              mode: event.currentTarget.value as LibraryBulkMetadataFieldMode,
                            })
                          }
                        >
                          <option value="unchanged">Unchanged</option>
                          <option value="replace">Replace</option>
                          <option value="clear">Clear</option>
                        </select>
                      </label>
                      <label htmlFor={inputId}>
                        <span>New value</span>
                        <input
                          id={inputId}
                          name={`library-bulk-metadata-${field.key}`}
                          type="text"
                          inputMode={field.inputMode}
                          autoComplete="off"
                          placeholder={field.placeholder}
                          value={entry.value}
                          disabled={pending || entry.mode !== "replace"}
                          aria-invalid={fieldError === undefined ? undefined : true}
                          aria-describedby={`${helpId}${
                            fieldError === undefined ? "" : ` ${fieldErrorId}`
                          }`}
                          onChange={(event) =>
                            updateField(field.key, { value: event.currentTarget.value })
                          }
                        />
                      </label>
                    </div>
                    <small id={helpId}>{field.help}</small>
                    {fieldError !== undefined && (
                      <p id={fieldErrorId} className="library-bulk-metadata-dialog__field-error">
                        {fieldError}
                      </p>
                    )}
                  </fieldset>
                );
              })}
            </div>

            <p
              id={statusId}
              className="library-bulk-metadata-dialog__status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {pending ? `Updating metadata for ${selectionLabel}…` : ""}
            </p>

            {visibleError !== null && (
              <p id={errorId} className="library-bulk-metadata-dialog__error" role="alert">
                {visibleError}
              </p>
            )}
          </div>

          <footer className="library-bulk-metadata-dialog__actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending || !hasChanges}>
              {pending ? "Updating…" : "Apply metadata"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
