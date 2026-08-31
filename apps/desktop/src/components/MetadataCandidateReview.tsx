import type { LibraryItem } from "@takio/core";
import { metadataCandidateApplyValueSchemaForRequest, type MetadataCandidate } from "@takio/library-contract";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  applyMetadataCandidate,
  discardMetadataCandidateCovers,
  describeLibraryError,
  listMetadataCandidates,
} from "../lib/library";
import {
  MetadataCandidateFieldControls,
  metadataCandidateProvenanceLabel,
  metadataCandidateSourceLabel,
  type MetadataCandidateField,
} from "./MetadataCandidateFieldControls";

import "./MetadataCandidateReview.css";

type Props = {
  readonly disabled?: boolean;
  readonly item: LibraryItem;
  readonly onApplied: (item: LibraryItem) => void;
  /** Injectable for tests; defaults to the real bridge calls. */
  readonly listCandidates?: typeof listMetadataCandidates;
  readonly applyCandidate?: typeof applyMetadataCandidate;
  readonly discardCandidates?: typeof discardMetadataCandidateCovers;
};

export function MetadataCandidateReview({
  disabled = false,
  item,
  onApplied,
  listCandidates = listMetadataCandidates,
  applyCandidate = applyMetadataCandidate,
  discardCandidates = discardMetadataCandidateCovers,
}: Props) {
  const [includeOnline, setIncludeOnline] = useState(false);
  const [candidates, setCandidates] = useState<readonly MetadataCandidate[]>([]);
  const [selected, setSelected] = useState<Record<string, readonly MetadataCandidateField[]>>({});
  const [selectedCovers, setSelectedCovers] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Every in-flight request carries the item it was issued for plus a
  // monotonic token, so responses that arrive after the selection changed (or
  // after a newer request started) are discarded instead of applied.
  const request = useRef({ itemId: item.id, token: 0 });
  const retainedCandidates = useRef<readonly MetadataCandidate[]>([]);

  async function discard(values: readonly MetadataCandidate[]): Promise<void> {
    try {
      await discardCandidates(values);
    } catch {
      // Candidate stages are also bounded by TTL and garbage collection.
    }
  }

  useEffect(() => {
    request.current = { itemId: item.id, token: request.current.token + 1 };
    const retained = retainedCandidates.current;
    retainedCandidates.current = [];
    void discard(retained);
    setCandidates([]);
    setSelected({});
    setSelectedCovers({});
    setStatus("");
    setBusy(false);
    return () => {
      request.current = { itemId: item.id, token: request.current.token + 1 };
      const abandoned = retainedCandidates.current;
      retainedCandidates.current = [];
      void discard(abandoned);
    };
  }, [discardCandidates, item.id]);

  function issue() {
    const token = request.current.token + 1;
    request.current = { itemId: item.id, token };
    return { itemId: item.id, token };
  }

  function isCurrent(issued: { itemId: string; token: number }): boolean {
    return request.current.itemId === issued.itemId && request.current.token === issued.token;
  }

  async function loadCandidates() {
    const issued = issue();
    const previous = retainedCandidates.current;
    retainedCandidates.current = [];
    setCandidates([]);
    setBusy(true);
    setStatus("Looking for metadata candidates.");
    try {
      if (previous.length > 0) await discard(previous);
      if (!isCurrent(issued)) return;
      const result = await listCandidates({ itemId: issued.itemId, includeOnline });
      if (!isCurrent(issued)) {
        if (result.ok) await discard(result.value.candidates);
        return;
      }
      if (!result.ok) {
        setStatus(describeLibraryError(result.error.code));
        return;
      }
      const candidates = result.value.candidates;
      if (result.value.itemId !== issued.itemId
        || candidates.some((candidate) => candidate.provenance.itemId !== issued.itemId)) {
        await discard(candidates);
        setStatus("The metadata candidate response did not match the selected book.");
        return;
      }
      retainedCandidates.current = candidates;
      setCandidates(candidates);
      setSelected({});
      setSelectedCovers({});
      setStatus(candidates.length === 0
        ? "No metadata candidates were found."
        : `Found ${candidates.length} metadata candidate${candidates.length === 1 ? "" : "s"}. Select fields to apply.`);
    } catch {
      if (!isCurrent(issued)) return;
      setStatus("Metadata candidates could not be loaded.");
    } finally {
      if (isCurrent(issued)) setBusy(false);
    }
  }

  function toggle(candidateId: string, field: MetadataCandidateField, checked: boolean) {
    setSelected((current) => {
      const fields = current[candidateId] ?? [];
      return {
        ...current,
        [candidateId]: checked
          ? [...fields, field]
          : fields.filter((candidateField) => candidateField !== field),
      };
    });
  }

  async function apply(event: FormEvent, candidate: MetadataCandidate) {
    event.preventDefault();
    const fields = selected[candidate.id] ?? [];
    const cover = selectedCovers[candidate.id] === true;
    if (fields.length === 0 && !cover) {
      setStatus("Select at least one field or the candidate cover before applying.");
      return;
    }
    if (candidate.provenance.itemId !== item.id) {
      setStatus("This candidate belongs to a different book and was not applied.");
      return;
    }
    const issued = issue();
    setBusy(true);
    setStatus(cover && fields.length === 0
      ? "Applying the selected cover."
      : `Applying ${fields.length} selected field${fields.length === 1 ? "" : "s"}${cover ? " and cover" : ""}.`);
    try {
      const applyRequest = {
        itemId: issued.itemId,
        candidate,
        fields,
        cover,
        provenance: `desktop-candidate-review:${candidate.source}`,
      } as const;
      const result = await applyCandidate(applyRequest);
      if (!isCurrent(issued)) return;
      if (!result.ok) {
        setStatus(describeLibraryError(result.error.code));
        return;
      }
      if (!metadataCandidateApplyValueSchemaForRequest(applyRequest).safeParse(result.value).success) {
        await discard(candidates);
        retainedCandidates.current = [];
        setCandidates([]);
        setStatus("The metadata apply response did not match the selected candidate.");
        return;
      }
      await discard(candidates);
      retainedCandidates.current = [];
      onApplied(result.value.item);
      setCandidates([]);
      setSelected({});
      setSelectedCovers({});
      const applied = result.value.applied;
      const summary = [
        applied.fields.length > 0 ? `${applied.fields.length} metadata field${applied.fields.length === 1 ? "" : "s"}` : null,
        applied.coverApplied ? "cover" : null,
      ].filter(Boolean).join(" and ");
      setStatus(`Applied ${summary} from ${metadataCandidateSourceLabel(candidate).toLowerCase()}.`);
    } catch {
      if (!isCurrent(issued)) return;
      setStatus("The selected metadata fields could not be applied.");
    } finally {
      if (isCurrent(issued)) setBusy(false);
    }
  }

  return (
    <section className="metadata-candidate-review" aria-labelledby="metadata-candidate-heading">
      <div className="metadata-candidate-review__heading">
        <h3 id="metadata-candidate-heading">Metadata candidates</h3>
        <button type="button" disabled={disabled || busy} onClick={() => void loadCandidates()}>
          {busy ? "Working..." : "Review"}
        </button>
      </div>
      <label className="metadata-candidate-review__online">
        <input
          type="checkbox"
          checked={includeOnline}
          disabled={disabled || busy}
          onChange={(event) => setIncludeOnline(event.currentTarget.checked)}
        />
        Include online provider
      </label>
      <p className="metadata-candidate-review__hint">Nothing is changed until you select fields and apply them.</p>
      <p className="metadata-candidate-review__status" role="status" aria-live="polite">{status}</p>

      {candidates.map((candidate) => {
        const selectedFields = selected[candidate.id] ?? [];
        const coverSelected = selectedCovers[candidate.id] === true;
        return (
          <form key={candidate.id} className="metadata-candidate-review__candidate" onSubmit={(event) => void apply(event, candidate)}>
            <header>
              <strong>{metadataCandidateSourceLabel(candidate)}</strong>
              <span>{candidate.confidence} confidence</span>
            </header>
            <p className="metadata-candidate-review__provenance">Source: {metadataCandidateProvenanceLabel(candidate)}</p>
            <MetadataCandidateFieldControls
              candidate={candidate}
              item={item}
              selectedFields={selectedFields}
              disabled={disabled || busy}
              coverSelected={coverSelected}
              onToggle={(field, checked) => toggle(candidate.id, field, checked)}
              onToggleCover={(checked) => setSelectedCovers((current) => ({ ...current, [candidate.id]: checked }))}
            />
            <button type="submit" disabled={disabled || busy || (selectedFields.length === 0 && !coverSelected)}>
              Apply selection
            </button>
          </form>
        );
      })}
    </section>
  );
}
