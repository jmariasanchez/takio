import type { LibraryItem } from "@takio/core";
import type { MetadataCandidate } from "@takio/library-contract";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  applyMetadataCandidate,
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
};

export function MetadataCandidateReview({
  disabled = false,
  item,
  onApplied,
  listCandidates = listMetadataCandidates,
  applyCandidate = applyMetadataCandidate,
}: Props) {
  const [includeOnline, setIncludeOnline] = useState(false);
  const [candidates, setCandidates] = useState<readonly MetadataCandidate[]>([]);
  const [selected, setSelected] = useState<Record<string, readonly MetadataCandidateField[]>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Every in-flight request carries the item it was issued for plus a
  // monotonic token, so responses that arrive after the selection changed (or
  // after a newer request started) are discarded instead of applied.
  const request = useRef({ itemId: item.id, token: 0 });

  useEffect(() => {
    request.current = { itemId: item.id, token: request.current.token + 1 };
    setCandidates([]);
    setSelected({});
    setStatus("");
    setBusy(false);
  }, [item.id]);

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
    setBusy(true);
    setStatus("Looking for metadata candidates.");
    try {
      const result = await listCandidates({ itemId: issued.itemId, includeOnline });
      if (!isCurrent(issued)) return;
      if (!result.ok) {
        setStatus(describeLibraryError(result.error.code));
        return;
      }
      const candidates = result.value.itemId === issued.itemId
        ? result.value.candidates.filter(
            (candidate) => candidate.provenance.itemId === issued.itemId,
          )
        : [];
      setCandidates(candidates);
      setSelected({});
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
    if (fields.length === 0) {
      setStatus("Select at least one field before applying this candidate.");
      return;
    }
    if (candidate.provenance.itemId !== item.id) {
      setStatus("This candidate belongs to a different book and was not applied.");
      return;
    }
    const issued = issue();
    setBusy(true);
    setStatus(`Applying ${fields.length} selected field${fields.length === 1 ? "" : "s"}.`);
    try {
      const result = await applyCandidate({
        itemId: issued.itemId,
        candidate,
        fields,
        provenance: `desktop-candidate-review:${candidate.source}`,
      });
      if (!isCurrent(issued)) return;
      if (!result.ok) {
        setStatus(describeLibraryError(result.error.code));
        return;
      }
      onApplied(result.value.item);
      setCandidates([]);
      setSelected({});
      setStatus(`Applied ${fields.length} selected field${fields.length === 1 ? "" : "s"} from ${metadataCandidateSourceLabel(candidate).toLowerCase()}.`);
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
              onToggle={(field, checked) => toggle(candidate.id, field, checked)}
            />
            <button type="submit" disabled={disabled || busy || selectedFields.length === 0}>
              Apply selected fields
            </button>
          </form>
        );
      })}
    </section>
  );
}
