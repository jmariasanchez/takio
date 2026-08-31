import type { LibraryItem } from "@takio/core";
import {
  MAX_BULK_METADATA_CANDIDATE_ITEMS,
  BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
  bulkMetadataCandidateDiscoveryRequestSchema,
  bulkMetadataCandidateDiscoveryResultSchemaFor,
  bulkMetadataCandidateReviewResultSchemaFor,
  metadataCandidateApplyValueSchemaForRequest,
  type MetadataCandidate,
} from "@takio/library-contract";
import { useEffect, useId, useRef, useState } from "react";

import {
  discoverBulkMetadataCandidates,
  type BulkMetadataDiscoveryOutcome,
} from "../lib/bulk-metadata-candidates";
import {
  applyMetadataCandidate,
  describeLibraryError,
  discardMetadataCandidateCovers,
  getLibraryItem,
  listMetadataCandidates,
} from "../lib/library";
import {
  MetadataCandidateFieldControls,
  metadataCandidateProvenanceLabel,
  metadataCandidateSourceLabel,
  type MetadataCandidateField,
} from "./MetadataCandidateFieldControls";
import "./MetadataCandidateReview.css";
import "./LibraryBulkMetadataCandidateDialog.css";

type FinalStatus = "applied" | "skipped" | "no-candidates" | "missing" | "failed" | "canceled";
type ReviewedOutcome = Readonly<{
  itemId: string;
  status: FinalStatus;
  item?: LibraryItem;
  candidateId?: string;
  fields?: readonly string[];
  coverApplied?: boolean;
  cover?: Readonly<{ mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; extension: ".jpg" | ".png" | ".gif" | ".webp"; bytes: number; sha256: string }>;
  code?: string;
}>;

type Props = Readonly<{
  open: boolean;
  itemIds: readonly string[];
  onClose: () => void;
  onApplied: (item: LibraryItem) => void;
  getItem?: typeof getLibraryItem;
  listCandidates?: typeof listMetadataCandidates;
  applyCandidate?: typeof applyMetadataCandidate;
  discardCandidates?: typeof discardMetadataCandidateCovers;
}>;

const focusableSelector = "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

function finalCounts(outcomes: readonly ReviewedOutcome[]) {
  const counts: Record<FinalStatus, number> = {
    applied: 0,
    skipped: 0,
    "no-candidates": 0,
    missing: 0,
    failed: 0,
    canceled: 0,
  };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}

function initialReviewed(outcomes: readonly BulkMetadataDiscoveryOutcome[]): ReviewedOutcome[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === "ready"
      ? []
      : [{ itemId: outcome.itemId, status: outcome.status, ...(outcome.status === "failed" ? { code: outcome.code } : {}) }],
  );
}

export function LibraryBulkMetadataCandidateDialog({
  open,
  itemIds,
  onClose,
  onApplied,
  getItem = getLibraryItem,
  listCandidates = listMetadataCandidates,
  applyCandidate = applyMetadataCandidate,
  discardCandidates = discardMetadataCandidateCovers,
}: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(false);
  const lifetimeRef = useRef(0);
  const retainedCandidatesRef = useRef<readonly MetadataCandidate[]>([]);
  const [phase, setPhase] = useState<"setup" | "discovery" | "review" | "complete">("setup");
  const [includeOnline, setIncludeOnline] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [outcomes, setOutcomes] = useState<readonly BulkMetadataDiscoveryOutcome[]>([]);
  const [reviewed, setReviewed] = useState<readonly ReviewedOutcome[]>([]);
  const [currentItemId, setCurrentItemId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, readonly MetadataCandidateField[]>>({});
  const [selectedCovers, setSelectedCovers] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState("");

  const ready = outcomes.filter(
    (outcome): outcome is Extract<BulkMetadataDiscoveryOutcome, { status: "ready" }> =>
      outcome.status === "ready",
  );
  const unresolved = ready.filter(
    (outcome) => !reviewed.some((entry) => entry.itemId === outcome.itemId),
  );
  const current = ready.find((outcome) => outcome.itemId === currentItemId) ?? unresolved[0] ?? null;
  const currentIndex = current ? ready.findIndex((outcome) => outcome.itemId === current.itemId) : -1;

  async function discard(candidates: readonly MetadataCandidate[]): Promise<void> {
    try {
      await discardCandidates(candidates);
    } catch {
      // Candidate stages are also bounded by TTL and garbage collection.
    }
  }

  useEffect(() => {
    if (!open) return;
    const lifetime = lifetimeRef.current + 1;
    lifetimeRef.current = lifetime;
    openerRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current = false;
    retainedCandidatesRef.current = [];
    setPhase("setup");
    setIncludeOnline(false);
    setCompleted(0);
    setOutcomes([]);
    setReviewed([]);
    setCurrentItemId(null);
    setSelected({});
    setSelectedCovers({});
    setBusy(false);
    setError(null);
    setLive(`Ready to review ${itemIds.length} selected books.`);
    requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      if (lifetimeRef.current === lifetime) lifetimeRef.current += 1;
      cancelRef.current = true;
      const candidates = retainedCandidatesRef.current;
      retainedCandidatesRef.current = [];
      void discard(candidates);
      if (openerRef.current?.isConnected) {
        openerRef.current.focus();
      } else {
        document.querySelector<HTMLElement>("#library-search:not([disabled])")?.focus();
      }
    };
  }, [discardCandidates, open, itemIds]);

  useEffect(() => {
    if (!open) return;
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && phase !== "discovery" && !busy) {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const elements = [...dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)];
      if (elements.length === 0) return;
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      if (!elements.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [busy, onClose, open, phase]);

  async function startDiscovery() {
    const lifetime = lifetimeRef.current;
    const request = {
      schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
      itemIds: [...itemIds],
      includeOnline,
      concurrency: 2,
    };
    const parsed = bulkMetadataCandidateDiscoveryRequestSchema.safeParse(request);
    if (!parsed.success || itemIds.length > MAX_BULK_METADATA_CANDIDATE_ITEMS) {
      setError(`Choose no more than ${MAX_BULK_METADATA_CANDIDATE_ITEMS} books to review.`);
      return;
    }
    setPhase("discovery");
    setError(null);
    setLive(`Discovering metadata for 0 of ${itemIds.length} books.`);
    const result = await discoverBulkMetadataCandidates(parsed.data, {
      getItem,
      listCandidates,
      isCanceled: () => cancelRef.current,
      onProgress: (nextCompleted, total) => {
        if (lifetimeRef.current !== lifetime) return;
        setCompleted(nextCompleted);
        setLive(`Discovering metadata for ${nextCompleted} of ${total} books.`);
      },
    });
    if (lifetimeRef.current !== lifetime) {
      await Promise.all(result.outcomes.flatMap((outcome) =>
        outcome.status === "ready" ? [discard(outcome.candidates)] : [],
      ));
      return;
    }
    const contractResult = {
      schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
      outcomes: result.outcomes.map((outcome) => outcome.status === "ready"
        ? { status: outcome.status, itemId: outcome.itemId, candidates: outcome.candidates }
        : outcome.status === "failed"
          ? { status: outcome.status, itemId: outcome.itemId, code: outcome.code }
          : { status: outcome.status, itemId: outcome.itemId }),
      counts: {
        total: result.counts.total,
        ready: result.counts.ready,
        noCandidates: result.counts["no-candidates"],
        missing: result.counts.missing,
        failed: result.counts.failed,
        canceled: result.counts.canceled,
      },
    };
    const validated = bulkMetadataCandidateDiscoveryResultSchemaFor(parsed.data).safeParse(contractResult);
    if (!validated.success) {
      await Promise.all(result.outcomes.flatMap((outcome) =>
        outcome.status === "ready" ? [discard(outcome.candidates)] : [],
      ));
      setError("The metadata discovery report was invalid.");
      setPhase("complete");
      return;
    }
    setOutcomes(result.outcomes);
    retainedCandidatesRef.current = result.outcomes.flatMap((outcome) =>
      outcome.status === "ready" ? outcome.candidates : [],
    );
    const classified = initialReviewed(result.outcomes);
    setReviewed(classified);
    const firstReady = result.outcomes.find((outcome) => outcome.status === "ready");
    setCurrentItemId(firstReady?.itemId ?? null);
    setPhase(firstReady ? "review" : "complete");
    setLive(firstReady ? `${result.counts.ready} books are ready for review.` : "Metadata review is complete.");
  }

  function cancelDiscovery() {
    cancelRef.current = true;
    setLive("Canceling discovery. Waiting for active book checks to finish.");
  }

  async function resolveCurrent(
    status: "skipped" | "applied",
    item?: LibraryItem,
    candidateId?: string,
    fields?: readonly string[],
    coverApplied?: boolean,
    cover?: ReviewedOutcome["cover"],
  ) {
    if (!current) return;
    await discard(current.candidates);
    const nextReviewed = [...reviewed, { itemId: current.itemId, status, item, candidateId, fields, coverApplied, cover }];
    setReviewed(nextReviewed);
    setSelected({});
    setSelectedCovers({});
    const next = ready.find((outcome) => !nextReviewed.some((entry) => entry.itemId === outcome.itemId));
    if (next) {
      setCurrentItemId(next.itemId);
      setLive(`${status === "applied" ? "Applied" : "Skipped"} ${current.item.title}. ${ready.length - nextReviewed.filter((entry) => ready.some(({ itemId }) => itemId === entry.itemId)).length} ready books remain.`);
    } else {
      setCurrentItemId(null);
      setPhase("complete");
      setLive("Metadata review is complete.");
    }
  }

  async function apply(candidate: MetadataCandidate) {
    if (!current) return;
    const fields = selected[candidate.id] ?? [];
    const cover = selectedCovers[candidate.id] === true;
    if (fields.length === 0 && !cover) {
      setError("Select at least one field or the candidate cover before applying.");
      return;
    }
    setBusy(true);
    setError(null);
    setLive(`Applying ${fields.length} selected field${fields.length === 1 ? "" : "s"}${cover ? `${fields.length > 0 ? " and" : ""} cover` : ""} to ${current.item.title}.`);
    try {
      const applyRequest = {
        itemId: current.itemId,
        candidate,
        fields,
        cover,
        provenance: `desktop-bulk-candidate-review:${candidate.source}`,
      } as const;
      const result = await applyCandidate(applyRequest);
      if (!result.ok || !metadataCandidateApplyValueSchemaForRequest(applyRequest).safeParse(result.value).success) {
        setError(!result.ok ? describeLibraryError(result.error.code) : "The metadata apply response did not match the selected candidate.");
        return;
      }
      onApplied(result.value.item);
      await resolveCurrent("applied", result.value.item, candidate.id, result.value.applied.fields, result.value.applied.coverApplied, result.value.applied.cover);
    } catch {
      setError("The selected metadata fields could not be applied.");
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    lifetimeRef.current += 1;
    cancelRef.current = true;
    const candidates = retainedCandidatesRef.current;
    retainedCandidatesRef.current = [];
    void discard(candidates);
    onClose();
  }

  function navigate(direction: -1 | 1) {
    if (!current) return;
    for (let offset = 1; offset <= ready.length; offset += 1) {
      const candidate = ready[(currentIndex + direction * offset + ready.length) % ready.length]!;
      if (!reviewed.some((entry) => entry.itemId === candidate.itemId)) {
        setCurrentItemId(candidate.itemId);
        setSelected({});
        setSelectedCovers({});
        setError(null);
        return;
      }
    }
  }

  if (!open) return null;
  const counts = finalCounts(reviewed);
  const orderedReviewed: unknown[] = itemIds.flatMap((itemId): unknown[] => {
    const outcome = reviewed.find((entry) => entry.itemId === itemId);
    if (!outcome) return [];
    if (outcome.status === "applied") {
      return [{ status: outcome.status, itemId, item: outcome.item, candidateId: outcome.candidateId, fields: outcome.fields, coverApplied: outcome.coverApplied, ...(outcome.cover ? { cover: outcome.cover } : {}) }];
    }
    if (outcome.status === "failed") return [{ status: outcome.status, itemId, code: outcome.code ?? "unexpected-error" }];
    return [{ status: outcome.status, itemId }];
  });
  const report = {
    schemaVersion: BULK_METADATA_CANDIDATE_SCHEMA_VERSION,
    outcomes: orderedReviewed,
    counts: {
      total: reviewed.length,
      applied: counts.applied,
      skipped: counts.skipped,
      noCandidates: counts["no-candidates"],
      missing: counts.missing,
      failed: counts.failed,
      canceled: counts.canceled,
    },
  };
  const reportValid = phase !== "complete" || bulkMetadataCandidateReviewResultSchemaFor(itemIds).safeParse(report).success;

  return (
    <div className="library-bulk-candidate-dialog__overlay">
      <div
        ref={dialogRef}
        className="library-bulk-candidate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={phase === "discovery" || busy}
        tabIndex={-1}
      >
        <header>
          <div>
            <span>Bulk metadata</span>
            <h2 id={titleId}>Review metadata candidates</h2>
          </div>
          {phase === "discovery" ? null : <button type="button" disabled={busy} onClick={closeDialog}>Close</button>}
        </header>
        <div className="library-bulk-candidate-dialog__body">
          <p id={descriptionId}>Review candidates for {itemIds.length} selected {itemIds.length === 1 ? "book" : "books"}. Nothing is applied automatically.</p>
          <p className="library-bulk-candidate-dialog__live" role="status" aria-live="polite" aria-atomic="true">{live}</p>
          {error ? <p className="library-bulk-candidate-dialog__error" role="alert">{error}</p> : null}

          {phase === "setup" ? (
            <section className="library-bulk-candidate-dialog__setup">
              <label><input type="checkbox" checked={includeOnline} onChange={(event) => setIncludeOnline(event.currentTarget.checked)} /> Include online provider</label>
              <small>Online lookup is off unless you explicitly select it.</small>
              <button type="button" onClick={() => void startDiscovery()}>Start review</button>
            </section>
          ) : null}

          {phase === "discovery" ? (
            <section className="library-bulk-candidate-dialog__discovery">
              <strong>{completed} of {itemIds.length} books checked</strong>
              <progress value={completed} max={itemIds.length}>{completed} of {itemIds.length}</progress>
              <button type="button" onClick={cancelDiscovery} disabled={cancelRef.current}>Cancel discovery</button>
            </section>
          ) : null}

          {phase === "review" && current ? (
            <section className="library-bulk-candidate-dialog__review">
              <div className="library-bulk-candidate-dialog__book">
                <span>Book {currentIndex + 1} of {ready.length}</span>
                <h3>{current.item.title}</h3>
                <small>{unresolved.length} unresolved</small>
              </div>
              {current.candidates.map((candidate) => {
                const fields = selected[candidate.id] ?? [];
                const coverSelected = selectedCovers[candidate.id] === true;
                return (
                  <form key={candidate.id} className="metadata-candidate-review__candidate" onSubmit={(event) => { event.preventDefault(); void apply(candidate); }}>
                    <header><strong>{metadataCandidateSourceLabel(candidate)}</strong><span>{candidate.confidence} confidence</span></header>
                    <p className="metadata-candidate-review__provenance">Source: {metadataCandidateProvenanceLabel(candidate)}</p>
                    <MetadataCandidateFieldControls candidate={candidate} item={current.item} selectedFields={fields} coverSelected={coverSelected} disabled={busy} onToggle={(field, checked) => setSelected((value) => ({ ...value, [candidate.id]: checked ? [...fields, field] : fields.filter((entry) => entry !== field) }))} onToggleCover={(checked) => setSelectedCovers((value) => ({ ...value, [candidate.id]: checked }))} />
                    <button type="submit" disabled={busy || (fields.length === 0 && !coverSelected)}>Apply selection</button>
                  </form>
                );
              })}
              <div className="library-bulk-candidate-dialog__navigation">
                <button type="button" disabled={busy || unresolved.length < 2} onClick={() => navigate(-1)}>Previous unresolved</button>
                <button type="button" disabled={busy} onClick={() => void resolveCurrent("skipped")}>Skip</button>
                <button type="button" disabled={busy || unresolved.length < 2} onClick={() => navigate(1)}>Next unresolved</button>
              </div>
            </section>
          ) : null}

          {phase === "complete" ? (
            <section className="library-bulk-candidate-dialog__report">
              <h3>Review complete</h3>
              <dl>
                {(["applied", "skipped", "no-candidates", "missing", "failed", "canceled"] as const).map((status) => <div key={status}><dt>{status}</dt><dd>{counts[status]}</dd></div>)}
              </dl>
              {!reportValid ? <p role="alert">The final review report did not account for every requested book.</p> : null}
              <button type="button" onClick={closeDialog}>Done</button>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
