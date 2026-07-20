import type { LibraryMetadataPatch } from "@takio/library-contract";
import type { AriaAttributes, FormEvent, ReactNode } from "react";

import {
  parseMetadataDraft,
  type ClearableMetadataDraftField,
  type MetadataDraft,
} from "../lib/metadata-draft";
import "./MetadataEditor.css";

export type MetadataEditorProps = Readonly<{
  draft: MetadataDraft;
  busy?: boolean;
  disabled?: boolean;
  idPrefix?: string;
  onCancel: () => void;
  onChange: (draft: MetadataDraft) => void;
  onSave: (patch: LibraryMetadataPatch) => void;
}>;

type FieldErrors = Readonly<Record<string, string>>;
type ClearableState = ClearableMetadataDraftField<unknown>["state"];

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  return values.map((current, currentIndex) =>
    currentIndex === index ? value : current,
  );
}

function moveAt<T>(values: readonly T[], index: number, direction: -1 | 1): readonly T[] {
  const target = index + direction;
  if (target < 0 || target >= values.length) return values;
  const moved = [...values];
  [moved[index], moved[target]] = [moved[target] as T, moved[index] as T];
  return moved;
}

function removeAt<T>(values: readonly T[], index: number): readonly T[] {
  return values.filter((_, currentIndex) => currentIndex !== index);
}

function controlId(idPrefix: string, path: string): string {
  return `${idPrefix}-${path.replaceAll(".", "-")}`;
}

function errorId(idPrefix: string, path: string): string {
  return `${controlId(idPrefix, path)}-error`;
}

function summaryTargetId(idPrefix: string, path: string): string {
  if (path === "form") return `${idPrefix}-heading`;
  if (path === "authors" || path === "languages" || path === "identifiers") {
    return `${controlId(idPrefix, path)}-change`;
  }
  return controlId(idPrefix, path);
}

function errorAttributes(
  fieldErrors: FieldErrors,
  idPrefix: string,
  path: string,
): Pick<AriaAttributes, "aria-describedby" | "aria-invalid"> {
  return fieldErrors[path]
    ? { "aria-describedby": errorId(idPrefix, path), "aria-invalid": true }
    : {};
}

function FieldError({
  fieldErrors,
  idPrefix,
  path,
}: Readonly<{ fieldErrors: FieldErrors; idPrefix: string; path: string }>) {
  const message = fieldErrors[path];
  return message ? (
    <p className="metadata-editor__field-error" id={errorId(idPrefix, path)}>
      {message}
    </p>
  ) : null;
}

function ChangeSelect({
  clearable = true,
  disabled,
  fieldErrors,
  idPrefix,
  label,
  name,
  state,
  onChange,
}: Readonly<{
  clearable?: boolean;
  disabled: boolean;
  fieldErrors: FieldErrors;
  idPrefix: string;
  label: string;
  name: string;
  state: ClearableState;
  onChange: (state: ClearableState) => void;
}>) {
  const id = `${controlId(idPrefix, name)}-change`;
  return (
    <label className="metadata-editor__change" htmlFor={id}>
      <span>Change</span>
      <select
        id={id}
        aria-label={`${label} change`}
        disabled={disabled}
        value={state}
        onChange={(event) => onChange(event.currentTarget.value as ClearableState)}
        {...errorAttributes(fieldErrors, idPrefix, name)}
      >
        <option value="unchanged">Keep current</option>
        <option value="concrete">Replace</option>
        {clearable && <option value="clear">Clear</option>}
      </select>
    </label>
  );
}

function TextField({
  disabled,
  field,
  fieldErrors,
  help,
  idPrefix,
  inputMode,
  label,
  multiline = false,
  name,
  onChange,
}: Readonly<{
  disabled: boolean;
  field: ClearableMetadataDraftField<string>;
  fieldErrors: FieldErrors;
  help?: string;
  idPrefix: string;
  inputMode?: "decimal" | "numeric" | "text";
  label: string;
  multiline?: boolean;
  name: string;
  onChange: (field: ClearableMetadataDraftField<string>) => void;
}>) {
  const id = controlId(idPrefix, name);
  const helpId = help ? `${id}-help` : undefined;
  const error = fieldErrors[name];
  const describedBy = [helpId, error ? errorId(idPrefix, name) : undefined]
    .filter(Boolean)
    .join(" ") || undefined;
  const inputProps = {
    id,
    value: field.value,
    disabled: disabled || field.state !== "concrete",
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    onChange: (event: { readonly currentTarget: { readonly value: string } }) =>
      onChange({ state: "concrete", value: event.currentTarget.value }),
  } as const;

  return (
    <div className="metadata-editor__field">
      <div className="metadata-editor__field-heading">
        <label htmlFor={id}>{label}</label>
        <ChangeSelect
          disabled={disabled}
          fieldErrors={fieldErrors}
          idPrefix={idPrefix}
          label={label}
          name={name}
          state={field.state}
          onChange={(state) => onChange({ ...field, state })}
        />
      </div>
      {multiline ? (
        <textarea {...inputProps} rows={4} />
      ) : (
        <input {...inputProps} inputMode={inputMode} type="text" />
      )}
      {help && <small id={helpId}>{help}</small>}
      <FieldError fieldErrors={fieldErrors} idPrefix={idPrefix} path={name} />
    </div>
  );
}

function GroupHeading({
  children,
  stateControl,
}: Readonly<{ children: ReactNode; stateControl?: ReactNode }>) {
  return (
    <div className="metadata-editor__group-heading">
      <span>{children}</span>
      {stateControl}
    </div>
  );
}

export function MetadataEditor({
  draft,
  busy = false,
  disabled = false,
  idPrefix = "metadata-editor",
  onCancel,
  onChange,
  onSave,
}: MetadataEditorProps) {
  const validation = parseMetadataDraft(draft);
  const fieldErrors = validation.ok ? {} : validation.fieldErrors;
  const controlsDisabled = disabled || busy;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = parseMetadataDraft(draft);
    if (parsed.ok) onSave(parsed.patch);
  }

  function change<K extends keyof MetadataDraft>(
    key: K,
    value: MetadataDraft[K],
  ): void {
    onChange({ ...draft, [key]: value });
  }

  function errorSummary(): ReactNode {
    if (validation.ok) return null;
    return (
      <div
        className="metadata-editor__error-summary"
        id={`${idPrefix}-error-summary`}
        role="alert"
        tabIndex={-1}
      >
        <strong>{validation.summary}</strong>
        <ul>
          {Object.entries(validation.fieldErrors).map(([path, message]) => (
            <li key={path}>
              <a href={`#${summaryTargetId(idPrefix, path)}`}>{message}</a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <form
      className="metadata-editor"
      aria-busy={busy || undefined}
      aria-labelledby={`${idPrefix}-heading`}
      noValidate
      onSubmit={submit}
    >
      <header className="metadata-editor__header">
        <div>
          <h2 id={`${idPrefix}-heading`} tabIndex={-1}>Edit metadata</h2>
          <p>Choose how each saved field should change.</p>
        </div>
      </header>

      <div className="metadata-editor__body">
        {errorSummary()}

        <fieldset disabled={controlsDisabled}>
          <legend>Basic</legend>
          <div className="metadata-editor__field">
            <div className="metadata-editor__field-heading">
              <label htmlFor={controlId(idPrefix, "title")}>Title</label>
              <ChangeSelect
                clearable={false}
                disabled={controlsDisabled}
                fieldErrors={fieldErrors}
                idPrefix={idPrefix}
                label="Title"
                name="title"
                state={draft.title.state}
                onChange={(state) =>
                  change("title", {
                    ...draft.title,
                    state: state === "clear" ? "unchanged" : state,
                  })
                }
              />
            </div>
            <input
              id={controlId(idPrefix, "title")}
              type="text"
              value={draft.title.value}
              disabled={draft.title.state !== "concrete"}
              onChange={(event) =>
                change("title", {
                  state: "concrete",
                  value: event.currentTarget.value,
                })
              }
              {...errorAttributes(fieldErrors, idPrefix, "title")}
            />
            <FieldError fieldErrors={fieldErrors} idPrefix={idPrefix} path="title" />
          </div>
        </fieldset>

        <fieldset disabled={controlsDisabled}>
          <legend>Contributors</legend>
          <div className="metadata-editor__group">
            <GroupHeading
              stateControl={
                <ChangeSelect
                  disabled={controlsDisabled}
                  fieldErrors={fieldErrors}
                  idPrefix={idPrefix}
                  label="Authors"
                  name="authors"
                  state={draft.authors.state}
                  onChange={(state) => change("authors", { ...draft.authors, state })}
                />
              }
            >
              Authors
            </GroupHeading>
            <ol className="metadata-editor__rows">
              {draft.authors.value.map((author, index) => {
                const namePath = `authors.${index}.name`;
                const sortNamePath = `authors.${index}.sortName`;
                return (
                  <li key={index}>
                    <div className="metadata-editor__row-fields">
                      <label>
                        <span>Name</span>
                        <input
                          id={controlId(idPrefix, namePath)}
                          type="text"
                          value={author.name}
                          disabled={draft.authors.state !== "concrete"}
                          onChange={(event) =>
                            change("authors", {
                              state: "concrete",
                              value: replaceAt(draft.authors.value, index, {
                                ...author,
                                name: event.currentTarget.value,
                              }),
                            })
                          }
                          {...errorAttributes(fieldErrors, idPrefix, namePath)}
                        />
                      </label>
                      <label>
                        <span>Sort name</span>
                        <input
                          id={controlId(idPrefix, sortNamePath)}
                          type="text"
                          value={author.sortName}
                          disabled={draft.authors.state !== "concrete"}
                          onChange={(event) =>
                            change("authors", {
                              state: "concrete",
                              value: replaceAt(draft.authors.value, index, {
                                ...author,
                                sortName: event.currentTarget.value,
                              }),
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="metadata-editor__row-actions">
                      <button
                        type="button"
                        aria-label={`Move author ${index + 1} up`}
                        disabled={draft.authors.state !== "concrete" || index === 0}
                        onClick={() =>
                          change("authors", {
                            state: "concrete",
                            value: moveAt(draft.authors.value, index, -1),
                          })
                        }
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        aria-label={`Move author ${index + 1} down`}
                        disabled={
                          draft.authors.state !== "concrete" ||
                          index === draft.authors.value.length - 1
                        }
                        onClick={() =>
                          change("authors", {
                            state: "concrete",
                            value: moveAt(draft.authors.value, index, 1),
                          })
                        }
                      >
                        Move down
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove author ${index + 1}`}
                        disabled={draft.authors.state !== "concrete"}
                        onClick={() =>
                          change("authors", {
                            state: "concrete",
                            value: removeAt(draft.authors.value, index),
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                    <FieldError
                      fieldErrors={fieldErrors}
                      idPrefix={idPrefix}
                      path={namePath}
                    />
                  </li>
                );
              })}
            </ol>
            <button
              className="metadata-editor__add"
              type="button"
              disabled={draft.authors.state !== "concrete"}
              onClick={() =>
                change("authors", {
                  state: "concrete",
                  value: [...draft.authors.value, { name: "", sortName: "" }],
                })
              }
            >
              Add author
            </button>
            <FieldError fieldErrors={fieldErrors} idPrefix={idPrefix} path="authors" />
          </div>
        </fieldset>

        <fieldset disabled={controlsDisabled}>
          <legend>Publication</legend>
          <TextField
            disabled={controlsDisabled}
            field={draft.series}
            fieldErrors={fieldErrors}
            idPrefix={idPrefix}
            label="Series"
            name="series"
            onChange={(field) => change("series", field)}
          />
          <TextField
            disabled={controlsDisabled}
            field={draft.seriesIndex}
            fieldErrors={fieldErrors}
            idPrefix={idPrefix}
            inputMode="decimal"
            label="Series index"
            name="seriesIndex"
            onChange={(field) => change("seriesIndex", field)}
          />
          <TextField
            disabled={controlsDisabled}
            field={draft.publisher}
            fieldErrors={fieldErrors}
            idPrefix={idPrefix}
            label="Publisher"
            name="publisher"
            onChange={(field) => change("publisher", field)}
          />

          <div className="metadata-editor__group">
            <GroupHeading
              stateControl={
                <ChangeSelect
                  disabled={controlsDisabled}
                  fieldErrors={fieldErrors}
                  idPrefix={idPrefix}
                  label="Languages"
                  name="languages"
                  state={draft.languages.state}
                  onChange={(state) => change("languages", { ...draft.languages, state })}
                />
              }
            >
              Languages
            </GroupHeading>
            <ol className="metadata-editor__rows metadata-editor__rows--compact">
              {draft.languages.value.map((language, index) => {
                const path = `languages.${index}`;
                return (
                  <li key={index}>
                    <label className="metadata-editor__grow">
                      <span>Language {index + 1}</span>
                      <input
                        id={controlId(idPrefix, path)}
                        type="text"
                        value={language}
                        disabled={draft.languages.state !== "concrete"}
                        aria-label={`Language ${index + 1}`}
                        onChange={(event) =>
                          change("languages", {
                            state: "concrete",
                            value: replaceAt(
                              draft.languages.value,
                              index,
                              event.currentTarget.value,
                            ),
                          })
                        }
                        {...errorAttributes(fieldErrors, idPrefix, path)}
                      />
                    </label>
                    <div className="metadata-editor__row-actions">
                      <button
                        type="button"
                        aria-label={`Move language ${index + 1} up`}
                        disabled={draft.languages.state !== "concrete" || index === 0}
                        onClick={() =>
                          change("languages", {
                            state: "concrete",
                            value: moveAt(draft.languages.value, index, -1),
                          })
                        }
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        aria-label={`Move language ${index + 1} down`}
                        disabled={
                          draft.languages.state !== "concrete" ||
                          index === draft.languages.value.length - 1
                        }
                        onClick={() =>
                          change("languages", {
                            state: "concrete",
                            value: moveAt(draft.languages.value, index, 1),
                          })
                        }
                      >
                        Down
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove language ${index + 1}`}
                        disabled={draft.languages.state !== "concrete"}
                        onClick={() =>
                          change("languages", {
                            state: "concrete",
                            value: removeAt(draft.languages.value, index),
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                    <FieldError fieldErrors={fieldErrors} idPrefix={idPrefix} path={path} />
                  </li>
                );
              })}
            </ol>
            <button
              className="metadata-editor__add"
              type="button"
              disabled={draft.languages.state !== "concrete"}
              onClick={() =>
                change("languages", {
                  state: "concrete",
                  value: [...draft.languages.value, ""],
                })
              }
            >
              Add language
            </button>
            <small>Use language tags such as en, en-US, or fr.</small>
            <FieldError fieldErrors={fieldErrors} idPrefix={idPrefix} path="languages" />
          </div>

          <TextField
            disabled={controlsDisabled}
            field={draft.publishedDate}
            fieldErrors={fieldErrors}
            help="Use YYYY, YYYY-MM, or YYYY-MM-DD."
            idPrefix={idPrefix}
            inputMode="numeric"
            label="Published date"
            name="publishedDate"
            onChange={(field) => change("publishedDate", field)}
          />
        </fieldset>

        <fieldset disabled={controlsDisabled}>
          <legend>Classification and identifiers</legend>
          <div className="metadata-editor__group">
            <GroupHeading
              stateControl={
                <ChangeSelect
                  disabled={controlsDisabled}
                  fieldErrors={fieldErrors}
                  idPrefix={idPrefix}
                  label="Identifiers"
                  name="identifiers"
                  state={draft.identifiers.state}
                  onChange={(state) =>
                    change("identifiers", { ...draft.identifiers, state })
                  }
                />
              }
            >
              Identifiers
            </GroupHeading>
            <ol className="metadata-editor__rows">
              {draft.identifiers.value.map((identifier, index) => {
                const typePath = `identifiers.${index}.type`;
                const valuePath = `identifiers.${index}.value`;
                return (
                  <li key={index}>
                    <div className="metadata-editor__row-fields metadata-editor__row-fields--identifier">
                      <label>
                        <span>Type</span>
                        <input
                          id={controlId(idPrefix, typePath)}
                          type="text"
                          value={identifier.type}
                          disabled={draft.identifiers.state !== "concrete"}
                          onChange={(event) =>
                            change("identifiers", {
                              state: "concrete",
                              value: replaceAt(draft.identifiers.value, index, {
                                ...identifier,
                                type: event.currentTarget.value,
                              }),
                            })
                          }
                          {...errorAttributes(fieldErrors, idPrefix, typePath)}
                        />
                      </label>
                      <label>
                        <span>Value</span>
                        <input
                          id={controlId(idPrefix, valuePath)}
                          type="text"
                          value={identifier.value}
                          disabled={draft.identifiers.state !== "concrete"}
                          onChange={(event) =>
                            change("identifiers", {
                              state: "concrete",
                              value: replaceAt(draft.identifiers.value, index, {
                                ...identifier,
                                value: event.currentTarget.value,
                              }),
                            })
                          }
                          {...errorAttributes(fieldErrors, idPrefix, valuePath)}
                        />
                      </label>
                    </div>
                    <button
                      className="metadata-editor__remove-row"
                      type="button"
                      aria-label={`Remove identifier ${index + 1}`}
                      disabled={draft.identifiers.state !== "concrete"}
                      onClick={() =>
                        change("identifiers", {
                          state: "concrete",
                          value: removeAt(draft.identifiers.value, index),
                        })
                      }
                    >
                      Remove
                    </button>
                    <FieldError
                      fieldErrors={fieldErrors}
                      idPrefix={idPrefix}
                      path={typePath}
                    />
                    <FieldError
                      fieldErrors={fieldErrors}
                      idPrefix={idPrefix}
                      path={valuePath}
                    />
                  </li>
                );
              })}
            </ol>
            <button
              className="metadata-editor__add"
              type="button"
              disabled={draft.identifiers.state !== "concrete"}
              onClick={() =>
                change("identifiers", {
                  state: "concrete",
                  value: [...draft.identifiers.value, { type: "", value: "" }],
                })
              }
            >
              Add identifier
            </button>
            <FieldError fieldErrors={fieldErrors} idPrefix={idPrefix} path="identifiers" />
          </div>

          <TextField
            disabled={controlsDisabled}
            field={draft.rating}
            fieldErrors={fieldErrors}
            help="Enter a number from 0 to 10."
            idPrefix={idPrefix}
            inputMode="decimal"
            label="Rating"
            name="rating"
            onChange={(field) => change("rating", field)}
          />

          <div className="metadata-editor__group">
            <GroupHeading>Tags</GroupHeading>
            <ol className="metadata-editor__rows metadata-editor__rows--compact">
              {draft.tags.value.map((tag, index) => {
                const path = `tags.${index}`;
                return (
                  <li key={index}>
                    <label className="metadata-editor__grow">
                      <span>Tag {index + 1}</span>
                      <input
                        id={controlId(idPrefix, path)}
                        type="text"
                        value={tag}
                        aria-label={`Tag ${index + 1}`}
                        onChange={(event) =>
                          change("tags", {
                            state: "concrete",
                            value: replaceAt(draft.tags.value, index, event.currentTarget.value),
                          })
                        }
                        {...errorAttributes(fieldErrors, idPrefix, path)}
                      />
                    </label>
                    <button
                      className="metadata-editor__remove-row"
                      type="button"
                      aria-label={`Remove tag ${index + 1}`}
                      onClick={() =>
                        change("tags", {
                          state: "concrete",
                          value: removeAt(draft.tags.value, index),
                        })
                      }
                    >
                      Remove
                    </button>
                    <FieldError fieldErrors={fieldErrors} idPrefix={idPrefix} path={path} />
                  </li>
                );
              })}
            </ol>
            <button
              className="metadata-editor__add"
              type="button"
              onClick={() =>
                change("tags", {
                  state: "concrete",
                  value: [...draft.tags.value, ""],
                })
              }
            >
              Add tag
            </button>
            <small>Saving replaces the complete tag list. An empty list clears all tags.</small>
          </div>
        </fieldset>

        <fieldset disabled={controlsDisabled}>
          <legend>Notes</legend>
          <TextField
            disabled={controlsDisabled}
            field={draft.description}
            fieldErrors={fieldErrors}
            idPrefix={idPrefix}
            label="Description"
            multiline
            name="description"
            onChange={(field) => change("description", field)}
          />
        </fieldset>
      </div>

      <footer className="metadata-editor__actions">
        <span className="metadata-editor__busy" aria-live="polite">
          {busy ? "Saving metadata…" : ""}
        </span>
        <button type="button" disabled={controlsDisabled} onClick={onCancel}>
          Cancel
        </button>
        <button className="metadata-editor__save" type="submit" disabled={controlsDisabled}>
          {busy ? "Saving…" : "Save"}
        </button>
      </footer>
    </form>
  );
}
