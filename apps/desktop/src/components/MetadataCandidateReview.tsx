import type { LibraryItem } from "@takio/core";
import type { MetadataCandidate } from "@takio/library-contract";
import { useEffect, useState, type FormEvent } from "react";

import {
  applyMetadataCandidate,
  describeLibraryError,
  listMetadataCandidates,
} from "../lib/library";

import "./MetadataCandidateReview.css";

type Props = {
  readonly disabled?: boolean;
  readonly item: LibraryItem;
  readonly onApplied: (item: LibraryItem) => void;
};

type CandidateField = keyof MetadataCandidate["patch"];

function displayValue(value: unknown): string {
  if (value === null) return "Not set";
  if (Array.isArray(value)) {
    return value.map((entry) => typeof entry === "object" && entry !== null && "name" in entry
      ? String(entry.name)
      : String(entry)).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${String(entry)}`)
      .join(", ");
  }
  return String(value);
}

function currentValue(item: LibraryItem, field: CandidateField): unknown {
  return item[field as keyof LibraryItem];
}

function sourceLabel(candidate: MetadataCandidate): string {
  if (candidate.source === "embedded") return "Embedded in this book";
  if (candidate.source === "online") return "Online metadata provider";
  return "Book filename";
}

function provenanceLabel(candidate: MetadataCandidate): string {
  const provenance = candidate.provenance;
  if (provenance.backend) return provenance.backend;
  if (provenance.pattern) return `Filename pattern: ${provenance.pattern}`;
  return provenance.sourcePath ?? candidate.source;
}

export function MetadataCandidateReview({ disabled = false, item, onApplied }: Props) {
  const [includeOnline, setIncludeOnline] = useState(false);
  const [candidates, setCandidates] = useState<readonly MetadataCandidate[]>([]);
  const [selected, setSelected] = useState<Record<string, readonly CandidateField[]>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setCandidates([]);
    setSelected({});
    setStatus("");
  }, [item.id]);

  async function loadCandidates() {
    setBusy(true);
    setStatus("Looking for metadata candidates.");
    try {
      const result = await listMetadataCandidates({ itemId: item.id, includeOnline });
      if (!result.ok) {
        setStatus(describeLibraryError(result.error.code));
        return;
      }
      setCandidates(result.value.candidates);
      setSelected({});
      setStatus(result.value.candidates.length === 0
        ? "No metadata candidates were found."
        : `Found ${result.value.candidates.length} metadata candidate${result.value.candidates.length === 1 ? "" : "s"}. Select fields to apply.`);
    } catch {
      setStatus("Metadata candidates could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(candidateId: string, field: CandidateField, checked: boolean) {
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
    setBusy(true);
    setStatus(`Applying ${fields.length} selected field${fields.length === 1 ? "" : "s"}.`);
    try {
      const result = await applyMetadataCandidate({
        itemId: item.id,
        candidate,
        fields,
        provenance: `desktop-candidate-review:${candidate.source}`,
      });
      if (!result.ok) {
        setStatus(describeLibraryError(result.error.code));
        return;
      }
      onApplied(result.value.item);
      setCandidates([]);
      setSelected({});
      setStatus(`Applied ${fields.length} selected field${fields.length === 1 ? "" : "s"} from ${sourceLabel(candidate).toLowerCase()}.`);
    } catch {
      setStatus("The selected metadata fields could not be applied.");
    } finally {
      setBusy(false);
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
        const fields = Object.keys(candidate.patch) as CandidateField[];
        const selectedFields = selected[candidate.id] ?? [];
        return (
          <form key={candidate.id} className="metadata-candidate-review__candidate" onSubmit={(event) => void apply(event, candidate)}>
            <header>
              <strong>{sourceLabel(candidate)}</strong>
              <span>{candidate.confidence} confidence</span>
            </header>
            <p className="metadata-candidate-review__provenance">Source: {provenanceLabel(candidate)}</p>
            <fieldset disabled={disabled || busy}>
              <legend>Select fields to apply</legend>
              {fields.map((field) => {
                const proposed = candidate.patch[field];
                return (
                  <label key={field} className="metadata-candidate-review__field">
                    <input
                      type="checkbox"
                      checked={selectedFields.includes(field)}
                      onChange={(event) => toggle(candidate.id, field, event.currentTarget.checked)}
                    />
                    <span>
                      <strong>{field}</strong>
                      <small>Current: {displayValue(currentValue(item, field))}</small>
                      <small>Candidate: {displayValue(proposed)}</small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <button type="submit" disabled={disabled || busy || selectedFields.length === 0}>
              Apply selected fields
            </button>
          </form>
        );
      })}
    </section>
  );
}
