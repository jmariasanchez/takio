import {
  FORMAT_CATALOG,
  type BookFormat,
  type FormatId,
  type LibraryItem,
} from "@takio/core";

import {
  conversionChoices,
  type ConversionChoice,
} from "../lib/conversion-choices";

import "./LibraryInspector.css";

type FormatAction = (item: LibraryItem, bookFormat: BookFormat) => void;
type ConversionAction = (item: LibraryItem, choice: ConversionChoice) => void;

export type LibraryInspectorProps = {
  readonly actionsDisabled?: boolean;
  readonly item: LibraryItem | null;
  readonly onConvertFormat: ConversionAction;
  readonly onOpenFormat: FormatAction;
  readonly onSendFormat: FormatAction;
};

function displayDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatLabel(format: FormatId): string {
  return (
    FORMAT_CATALOG.find(({ id }) => id === format)?.label ?? format.toUpperCase()
  );
}

function provenanceLabel(bookFormat: BookFormat): string {
  return bookFormat.provenance === "managed" ? "Managed copy" : "Linked file";
}

function authorLabel(item: LibraryItem): string | undefined {
  return item.authors?.map(({ name }) => name).join(", ") ?? item.author;
}

export function LibraryInspector({
  actionsDisabled = false,
  item,
  onConvertFormat,
  onOpenFormat,
  onSendFormat,
}: LibraryInspectorProps) {
  if (!item) {
    return (
      <aside className="library-inspector" aria-labelledby="library-inspector-heading">
        <header className="library-inspector__header">
          <p>Details</p>
          <h2 id="library-inspector-heading">No book selected</h2>
        </header>
        <p className="library-inspector__empty">Select a book to inspect its metadata and formats.</p>
      </aside>
    );
  }

  const authors = authorLabel(item);
  const choices = conversionChoices(item.formats);
  const identifiers = Object.entries(item.identifiers ?? {});

  return (
    <aside className="library-inspector" aria-labelledby="library-inspector-heading">
      <header className="library-inspector__header">
        <p>Selected book</p>
        <div className="library-inspector__identity">
          <span className="library-inspector__cover" aria-hidden="true">
            {item.title.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h2 id="library-inspector-heading">{item.title}</h2>
            {authors && <span>{authors}</span>}
          </div>
        </div>
      </header>

      <div className="library-inspector__body">
        <section className="library-inspector__section" aria-labelledby="inspector-metadata-heading">
          <h3 id="inspector-metadata-heading">Metadata</h3>
          <dl className="library-inspector__metadata">
            {authors && (
              <div>
                <dt>{item.authors && item.authors.length > 1 ? "Authors" : "Author"}</dt>
                <dd>{authors}</dd>
              </div>
            )}
            {item.series && (
              <div>
                <dt>Series</dt>
                <dd>{item.series}</dd>
              </div>
            )}
            {item.seriesIndex !== undefined && (
              <div>
                <dt>Series index</dt>
                <dd>{item.seriesIndex}</dd>
              </div>
            )}
            {item.publisher && (
              <div>
                <dt>Publisher</dt>
                <dd>{item.publisher}</dd>
              </div>
            )}
            {item.languages && (
              <div>
                <dt>{item.languages.length === 1 ? "Language" : "Languages"}</dt>
                <dd>{item.languages.join(", ")}</dd>
              </div>
            )}
            {identifiers.length > 0 && (
              <div>
                <dt>Identifiers</dt>
                <dd>
                  {identifiers
                    .map(([scheme, value]) => `${scheme.toUpperCase()}: ${value}`)
                    .join(", ")}
                </dd>
              </div>
            )}
            {item.publishedDate && (
              <div>
                <dt>Published</dt>
                <dd>
                  <time dateTime={item.publishedDate}>{item.publishedDate}</time>
                </dd>
              </div>
            )}
            {item.rating !== undefined && (
              <div>
                <dt>Rating</dt>
                <dd>{item.rating} / 10</dd>
              </div>
            )}
            <div>
              <dt>Added</dt>
              <dd>
                <time dateTime={item.addedAt}>{displayDate(item.addedAt)}</time>
              </dd>
            </div>
            {item.tags.length > 0 && (
              <div>
                <dt>Tags</dt>
                <dd>{item.tags.join(", ")}</dd>
              </div>
            )}
          </dl>
          {item.description && <p className="library-inspector__description">{item.description}</p>}
        </section>

        <section className="library-inspector__section" aria-labelledby="inspector-formats-heading">
          <div className="library-inspector__section-heading">
            <h3 id="inspector-formats-heading">Formats</h3>
            <span>{item.formats.length}</span>
          </div>
          <ul className="library-inspector__formats">
            {item.formats.map((bookFormat) => {
              const label = formatLabel(bookFormat.format);
              const formatChoices = choices.filter(({ source }) => source === bookFormat);

              return (
                <li key={bookFormat.format}>
                  <div className="library-inspector__format-heading">
                    <strong>{label}</strong>
                    <span>{provenanceLabel(bookFormat)}</span>
                  </div>
                  <div className="library-inspector__format-actions">
                    <button
                      type="button"
                      aria-label={`Open ${label} for ${item.title}`}
                      disabled={actionsDisabled}
                      onClick={() => onOpenFormat(item, bookFormat)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      aria-label={`Send ${label} for ${item.title}`}
                      disabled={actionsDisabled}
                      onClick={() => onSendFormat(item, bookFormat)}
                    >
                      Send
                    </button>
                    {formatChoices.map((choice) => {
                      const targetLabel = formatLabel(choice.target);

                      return (
                        <button
                          type="button"
                          aria-label={`Convert ${label} to ${targetLabel} for ${item.title}`}
                          disabled={actionsDisabled}
                          key={choice.target}
                          onClick={() => onConvertFormat(item, choice)}
                        >
                          Convert {label} to {targetLabel}
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </aside>
  );
}
