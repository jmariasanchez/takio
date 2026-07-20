import type { FormatId, LibraryItem } from "@takio/core";
import type {
  DuplicateCandidate,
  DuplicateSignal,
  KeepDuplicatePairRequest,
  LibraryMetadataPatch,
  MergeDuplicatePairRequest,
  ReopenDuplicatePairRequest,
} from "@takio/library-contract";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import "./LibraryDuplicateReviewDialog.css";

export type DuplicateReviewDisposition = "kept-both" | "unreviewed";
export type DuplicateReviewPendingAction = "keep" | "merge" | "reopen";
export type DuplicateMetadataPolicy = "source" | "target";
export type DuplicateCoverChoice = "none" | "source" | "target";

export type LibraryDuplicateReviewDialogProps = {
  readonly open: boolean;
  readonly candidates: readonly DuplicateCandidate[];
  readonly total: number;
  readonly pageOffset: number;
  readonly pageLimit: number;
  readonly disposition: DuplicateReviewDisposition;
  readonly loading: boolean;
  readonly pendingReviewToken: string | null;
  readonly pendingAction: DuplicateReviewPendingAction | null;
  readonly staleReviewToken: string | null;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onChangePage: (offset: number) => void;
  readonly onKeepSeparate: (request: KeepDuplicatePairRequest) => void;
  readonly onReopen: (request: ReopenDuplicatePairRequest) => void;
  readonly onMerge: (request: MergeDuplicatePairRequest) => void;
};

type PageAction = "next" | "previous";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function duplicateDialogFocusTarget(
  currentIndex: number,
  itemCount: number,
  backwards: boolean,
): number | null {
  if (itemCount === 0) {
    return null;
  }
  if (currentIndex < 0) {
    return backwards ? itemCount - 1 : 0;
  }
  if (backwards && currentIndex === 0) {
    return itemCount - 1;
  }
  if (!backwards && currentIndex === itemCount - 1) {
    return 0;
  }
  return null;
}

export function duplicatePageRange(
  pageOffset: number,
  candidateCount: number,
  total: number,
): { readonly start: number; readonly end: number } {
  if (candidateCount === 0 || total === 0) {
    return { start: 0, end: 0 };
  }
  return {
    start: pageOffset + 1,
    end: Math.min(pageOffset + candidateCount, total),
  };
}

export function duplicatePageTarget(
  action: PageAction,
  pageOffset: number,
  pageLimit: number,
  total: number,
): number | null {
  if (pageLimit <= 0) {
    return null;
  }
  if (action === "previous") {
    return pageOffset === 0 ? null : Math.max(0, pageOffset - pageLimit);
  }
  return pageOffset + pageLimit >= total ? null : pageOffset + pageLimit;
}

export function duplicatePairReviewRequest(
  candidate: DuplicateCandidate,
): KeepDuplicatePairRequest & ReopenDuplicatePairRequest {
  return {
    leftId: candidate.left.id,
    rightId: candidate.right.id,
    reviewToken: candidate.reviewToken,
  };
}

function sourceMetadataPatch(source: LibraryItem): LibraryMetadataPatch {
  return {
    title: source.title,
    author: source.author ?? null,
    authors: source.authors ?? null,
    series: source.series ?? null,
    seriesIndex: source.seriesIndex ?? null,
    publisher: source.publisher ?? null,
    languages: source.languages ?? null,
    identifiers: source.identifiers ?? null,
    publishedDate: source.publishedDate ?? null,
    rating: source.rating ?? null,
    description: source.description ?? null,
    tags: source.tags,
  };
}

export function buildDuplicateMergeRequest(
  candidate: DuplicateCandidate,
  targetId: string,
  metadataPolicy: DuplicateMetadataPolicy,
  addSourceFormats: readonly FormatId[],
  cover: DuplicateCoverChoice,
): MergeDuplicatePairRequest {
  const target = candidate.left.id === targetId
    ? candidate.left
    : candidate.right.id === targetId
      ? candidate.right
      : null;
  if (target === null) {
    throw new TypeError("The merge target must belong to the reviewed duplicate pair.");
  }

  const source = target === candidate.left ? candidate.right : candidate.left;
  const targetFormats = new Set(target.formats.map(({ format }) => format));
  const availableFormats = new Set(
    source.formats
      .filter(({ format }) => !targetFormats.has(format))
      .map(({ format }) => format),
  );
  const selectedFormats = new Set(addSourceFormats);
  if (
    selectedFormats.size !== addSourceFormats.length ||
    addSourceFormats.some((format) => !availableFormats.has(format))
  ) {
    throw new TypeError("Selected source formats must be unique and missing from the target.");
  }
  if (cover === "source" && source.coverPath === undefined) {
    throw new TypeError("The source has no cover to use.");
  }

  return {
    targetId: target.id,
    sourceId: source.id,
    reviewToken: candidate.reviewToken,
    metadata:
      metadataPolicy === "source" ? sourceMetadataPatch(source) : { tags: target.tags },
    addSourceFormats: source.formats
      .filter(({ format }) => selectedFormats.has(format))
      .map(({ format }) => format),
    cover,
  };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.closest('[hidden], [inert], [aria-hidden="true"]') === null,
  );
}

function authorLabel(item: LibraryItem): string {
  return item.authors?.map(({ name }) => name).join(", ") ?? item.author ?? "Unknown";
}

function textList(values: readonly string[] | undefined): string {
  return values?.length ? values.join(", ") : "—";
}

function identifiersLabel(item: LibraryItem): string {
  if (!item.identifiers || Object.keys(item.identifiers).length === 0) {
    return "—";
  }
  return Object.entries(item.identifiers)
    .map(([scheme, value]) => `${scheme}: ${value}`)
    .join(", ");
}

function signalLabel(signal: DuplicateSignal): string {
  switch (signal.kind) {
    case "same-content":
      return `Same file content · ${signal.leftFormat.toUpperCase()} ↔ ${signal.rightFormat.toUpperCase()} · ${signal.bytes.toLocaleString()} bytes · SHA-256 ${signal.sha256}`;
    case "same-identifier":
      return `Same identifier · ${signal.scheme}: ${signal.value}`;
    case "same-title-author":
      return `Same title and author · ${signal.title} · ${signal.author}`;
  }
}

function defaultCoverChoice(target: LibraryItem, source: LibraryItem): DuplicateCoverChoice {
  if (target.coverPath) {
    return "target";
  }
  return source.coverPath ? "source" : "none";
}

function missingSourceFormats(target: LibraryItem, source: LibraryItem): readonly FormatId[] {
  const targetFormats = new Set(target.formats.map(({ format }) => format));
  return source.formats
    .filter(({ format }) => !targetFormats.has(format))
    .map(({ format }) => format);
}

function ItemDetails({ item, side }: { readonly item: LibraryItem; readonly side: "Left" | "Right" }) {
  const series = item.series
    ? `${item.series}${item.seriesIndex === undefined ? "" : ` #${item.seriesIndex}`}`
    : "—";

  return (
    <section className="library-duplicate-dialog__book" aria-label={`${side} book: ${item.title}`}>
      <span className="library-duplicate-dialog__side">{side}</span>
      <h4>{item.title}</h4>
      <dl>
        <div><dt>Author</dt><dd>{authorLabel(item)}</dd></div>
        <div><dt>Series</dt><dd>{series}</dd></div>
        <div><dt>Publisher</dt><dd>{item.publisher ?? "—"}</dd></div>
        <div><dt>Published</dt><dd>{item.publishedDate ?? "—"}</dd></div>
        <div><dt>Languages</dt><dd>{textList(item.languages)}</dd></div>
        <div><dt>Identifiers</dt><dd>{identifiersLabel(item)}</dd></div>
        <div><dt>Rating</dt><dd>{item.rating === undefined ? "—" : `${item.rating}/10`}</dd></div>
        <div><dt>Tags</dt><dd>{textList(item.tags)}</dd></div>
        <div><dt>Added</dt><dd>{item.addedAt}</dd></div>
        <div><dt>Cover</dt><dd>{item.coverPath ? "Available" : "None"}</dd></div>
        <div><dt>Library ID</dt><dd><code>{item.id}</code></dd></div>
      </dl>
      <div className="library-duplicate-dialog__formats">
        <strong>Formats</strong>
        <ul>
          {item.formats.map((bookFormat) => (
            <li key={bookFormat.format}>
              <span>{bookFormat.format.toUpperCase()}</span>
              <small>{bookFormat.provenance} · {bookFormat.addedAt}</small>
              <code title={bookFormat.sourcePath}>{bookFormat.sourcePath}</code>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

type CandidateReviewProps = {
  readonly candidate: DuplicateCandidate;
  readonly index: number;
  readonly disposition: DuplicateReviewDisposition;
  readonly disabled: boolean;
  readonly pendingAction: DuplicateReviewPendingAction | null;
  readonly stale: boolean;
  readonly onKeepSeparate: (request: KeepDuplicatePairRequest) => void;
  readonly onReopen: (request: ReopenDuplicatePairRequest) => void;
  readonly onMerge: (request: MergeDuplicatePairRequest) => void;
};

function CandidateReview({
  candidate,
  index,
  disposition,
  disabled,
  pendingAction,
  stale,
  onKeepSeparate,
  onReopen,
  onMerge,
}: CandidateReviewProps) {
  const instanceId = useId();
  const [targetId, setTargetId] = useState(candidate.left.id);
  const [metadataPolicy, setMetadataPolicy] = useState<DuplicateMetadataPolicy>("target");
  const [selectedFormats, setSelectedFormats] = useState<readonly FormatId[]>(() =>
    missingSourceFormats(candidate.left, candidate.right),
  );
  const [cover, setCover] = useState<DuplicateCoverChoice>(() =>
    defaultCoverChoice(candidate.left, candidate.right),
  );
  const [confirming, setConfirming] = useState(false);
  const mergeButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const target = targetId === candidate.left.id ? candidate.left : candidate.right;
  const source = target === candidate.left ? candidate.right : candidate.left;
  const availableSourceFormats = missingSourceFormats(target, source);
  const actionDisabled = disabled || stale;
  const titleId = `${instanceId}-title`;
  const confirmationId = `${instanceId}-confirmation`;

  useEffect(() => {
    if (!confirming) {
      return;
    }
    const frame = window.requestAnimationFrame(() => confirmationCancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirming]);

  function chooseTarget(nextTarget: LibraryItem, nextSource: LibraryItem): void {
    setTargetId(nextTarget.id);
    setMetadataPolicy("target");
    setSelectedFormats(missingSourceFormats(nextTarget, nextSource));
    setCover(defaultCoverChoice(nextTarget, nextSource));
    setConfirming(false);
  }

  function toggleFormat(format: FormatId): void {
    setSelectedFormats((current) =>
      current.includes(format)
        ? current.filter((candidateFormat) => candidateFormat !== format)
        : [...current, format],
    );
  }

  function cancelConfirmation(): void {
    setConfirming(false);
    window.requestAnimationFrame(() => mergeButtonRef.current?.focus());
  }

  return (
    <article className="library-duplicate-dialog__candidate" aria-labelledby={titleId}>
      <header>
        <div>
          <span>Candidate {index + 1}</span>
          <h3 id={titleId}>{candidate.left.title} / {candidate.right.title}</h3>
        </div>
        {stale ? <strong className="library-duplicate-dialog__stale">Evidence changed</strong> : null}
      </header>

      <div className="library-duplicate-dialog__comparison">
        <ItemDetails item={candidate.left} side="Left" />
        <ItemDetails item={candidate.right} side="Right" />
      </div>

      <section className="library-duplicate-dialog__signals" aria-label="Duplicate evidence">
        <h4>Why these books match</h4>
        <ul>{candidate.signals.map((signal, signalIndex) => <li key={signalIndex}>{signalLabel(signal)}</li>)}</ul>
      </section>

      {disposition === "unreviewed" ? (
        <div className="library-duplicate-dialog__decision">
          <fieldset disabled={actionDisabled}>
            <legend>1. Choose the book to keep</legend>
            <label>
              <input
                type="radio"
                name={`${instanceId}-target`}
                checked={targetId === candidate.left.id}
                onChange={() => chooseTarget(candidate.left, candidate.right)}
              />
              Keep left · {candidate.left.title}
            </label>
            <label>
              <input
                type="radio"
                name={`${instanceId}-target`}
                checked={targetId === candidate.right.id}
                onChange={() => chooseTarget(candidate.right, candidate.left)}
              />
              Keep right · {candidate.right.title}
            </label>
          </fieldset>

          <fieldset disabled={actionDisabled}>
            <legend>2. Metadata</legend>
            <label>
              <input type="radio" name={`${instanceId}-metadata`} checked={metadataPolicy === "target"} onChange={() => setMetadataPolicy("target")} />
              Keep target metadata
            </label>
            <label>
              <input type="radio" name={`${instanceId}-metadata`} checked={metadataPolicy === "source"} onChange={() => setMetadataPolicy("source")} />
              Replace with source metadata
            </label>
          </fieldset>

          <fieldset disabled={actionDisabled}>
            <legend>3. Add formats from the source</legend>
            {availableSourceFormats.length === 0 ? <span>No missing formats are available.</span> : availableSourceFormats.map((format) => (
              <label key={format}>
                <input type="checkbox" checked={selectedFormats.includes(format)} onChange={() => toggleFormat(format)} />
                Add {format.toUpperCase()}
              </label>
            ))}
          </fieldset>

          <fieldset disabled={actionDisabled}>
            <legend>4. Cover</legend>
            <label>
              <input type="radio" name={`${instanceId}-cover`} checked={cover === "target"} onChange={() => setCover("target")} />
              Keep target cover{target.coverPath ? "" : " (none)"}
            </label>
            <label>
              <input type="radio" name={`${instanceId}-cover`} checked={cover === "source"} disabled={!source.coverPath || actionDisabled} onChange={() => setCover("source")} />
              Use source cover{source.coverPath ? "" : " (unavailable)"}
            </label>
            <label>
              <input type="radio" name={`${instanceId}-cover`} checked={cover === "none"} onChange={() => setCover("none")} />
              Remove cover
            </label>
          </fieldset>
        </div>
      ) : null}

      {stale ? (
        <p className="library-duplicate-dialog__pair-alert" role="alert">
          This pair changed after it was reviewed. Close and refresh duplicates before deciding.
        </p>
      ) : null}

      <div className="library-duplicate-dialog__actions" hidden={confirming} inert={confirming}>
        {disposition === "unreviewed" ? (
          <>
            <button type="button" disabled={actionDisabled} onClick={() => onKeepSeparate(duplicatePairReviewRequest(candidate))}>
              {pendingAction === "keep" ? "Keeping separate…" : "Keep separate"}
            </button>
            <button
              ref={mergeButtonRef}
              className="library-duplicate-dialog__merge"
              type="button"
              disabled={actionDisabled}
              aria-expanded={confirming}
              aria-controls={confirmationId}
              onClick={() => setConfirming(true)}
            >
              Review merge
            </button>
          </>
        ) : (
          <button type="button" disabled={actionDisabled} onClick={() => onReopen(duplicatePairReviewRequest(candidate))}>
            {pendingAction === "reopen" ? "Reopening…" : "Reopen review"}
          </button>
        )}
      </div>

      {disposition === "unreviewed" ? (
        <div
          className="library-duplicate-dialog__confirmation"
          id={confirmationId}
          role="group"
          aria-label={`Confirm merge into ${target.title}`}
          hidden={!confirming}
          inert={!confirming}
        >
          <p>
            Merge into <strong>{target.title}</strong> and move <strong>{source.title}</strong> intact to Trash?
          </p>
          <div>
            <button ref={confirmationCancelRef} type="button" disabled={actionDisabled} onClick={cancelConfirmation}>Cancel</button>
            <button
              className="library-duplicate-dialog__merge library-duplicate-dialog__merge--confirm"
              type="button"
              disabled={actionDisabled}
              onClick={() => onMerge(buildDuplicateMergeRequest(candidate, targetId, metadataPolicy, selectedFormats, cover))}
            >
              {pendingAction === "merge" ? "Merging…" : "Merge and move source to Trash"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function LibraryDuplicateReviewDialog({
  open,
  candidates,
  total,
  pageOffset,
  pageLimit,
  disposition,
  loading,
  pendingReviewToken,
  pendingAction,
  staleReviewToken,
  error,
  onClose,
  onChangePage,
  onKeepSeparate,
  onReopen,
  onMerge,
}: LibraryDuplicateReviewDialogProps) {
  const instanceId = useId();
  const titleId = `${instanceId}-title`;
  const statusId = `${instanceId}-status`;
  const errorId = `${instanceId}-error`;
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const previousOpen = useRef(false);
  const operationPending = pendingReviewToken !== null && pendingAction !== null;
  const range = duplicatePageRange(pageOffset, candidates.length, total);
  const previousPage = duplicatePageTarget("previous", pageOffset, pageLimit, total);
  const nextPage = duplicatePageTarget("next", pageOffset, pageLimit, total);
  const visibleError = error?.trim() || null;

  useEffect(() => {
    const opening = open && !previousOpen.current;
    const closing = !open && previousOpen.current;
    previousOpen.current = open;
    if (opening) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
    if (closing) {
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      const frame = window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) {
          returnTarget.focus();
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }
    return;
  }, [open]);

  if (!open) {
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex = duplicateDialogFocusTarget(currentIndex, focusable.length, event.shiftKey);
    if (targetIndex !== null) {
      event.preventDefault();
      focusable[targetIndex]?.focus();
    }
  }

  const status = loading
    ? "Loading duplicate candidates…"
    : operationPending
      ? `${pendingAction === "merge" ? "Merging" : pendingAction === "keep" ? "Keeping" : "Reopening"} duplicate pair…`
      : staleReviewToken
        ? "A duplicate pair has stale evidence."
        : "Duplicate evidence is up to date.";

  return (
    <div className="library-duplicate-dialog__overlay">
      <section
        ref={dialogRef}
        className="library-duplicate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${statusId}${visibleError === null ? "" : ` ${errorId}`}`}
        aria-busy={loading || operationPending}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="library-duplicate-dialog__header">
          <div>
            <span className="library-duplicate-dialog__eyebrow">Library maintenance</span>
            <h2 id={titleId}>Review duplicates</h2>
          </div>
          <button ref={closeButtonRef} className="library-duplicate-dialog__close" type="button" aria-label="Close duplicate review" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="library-duplicate-dialog__summary">
          <strong>{candidates.length.toLocaleString()} visible</strong>
          <span>{total.toLocaleString()} {disposition === "unreviewed" ? "to review" : "kept separate"}</span>
        </div>

        <div className="library-duplicate-dialog__status" id={statusId} role="status" aria-live="polite" aria-atomic="true">{status}</div>
        {visibleError ? <p className="library-duplicate-dialog__error" id={errorId} role="alert">{visibleError}</p> : null}

        <div className="library-duplicate-dialog__body">
          {!loading && candidates.length === 0 ? (
            <div className="library-duplicate-dialog__empty">
              <strong>{disposition === "unreviewed" ? "No duplicates need review" : "No pairs are kept separate"}</strong>
              <span>{disposition === "unreviewed" ? "New candidates will appear when matching evidence is found." : "Pairs marked Keep separate will appear here."}</span>
            </div>
          ) : null}
          {candidates.map((candidate, index) => (
            <CandidateReview
              key={candidate.reviewToken}
              candidate={candidate}
              index={pageOffset + index}
              disposition={disposition}
              disabled={loading || operationPending}
              pendingAction={pendingReviewToken === candidate.reviewToken ? pendingAction : null}
              stale={staleReviewToken === candidate.reviewToken}
              onKeepSeparate={onKeepSeparate}
              onReopen={onReopen}
              onMerge={onMerge}
            />
          ))}
        </div>

        <footer className="library-duplicate-dialog__footer">
          <span aria-live="polite">{range.start === 0 ? `0 of ${total}` : `${range.start}–${range.end} of ${total}`}</span>
          <nav aria-label="Duplicate candidate pages">
            <button type="button" disabled={loading || operationPending || previousPage === null} onClick={() => previousPage !== null && onChangePage(previousPage)}>Previous</button>
            <button type="button" disabled={loading || operationPending || nextPage === null} onClick={() => nextPage !== null && onChangePage(nextPage)}>Next</button>
          </nav>
        </footer>
      </section>
    </div>
  );
}
