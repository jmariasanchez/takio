import type { LibraryItem } from "@takio/core";
import type { MetadataCandidate } from "@takio/library-contract";

export type MetadataCandidateField = keyof MetadataCandidate["patch"];

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "Not set";
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === "object" && entry !== null && "name" in entry
          ? String(entry.name)
          : String(entry),
      )
      .join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${String(entry)}`)
      .join(", ");
  }
  return String(value);
}

export function metadataCandidateSourceLabel(candidate: MetadataCandidate): string {
  if (candidate.source === "embedded") return "Embedded in this book";
  if (candidate.source === "online") return "Online metadata provider";
  return "Book filename";
}

export function metadataCandidateProvenanceLabel(candidate: MetadataCandidate): string {
  const provenance = candidate.provenance;
  if (provenance.backend) return provenance.backend;
  if (provenance.pattern) return `Filename pattern: ${provenance.pattern}`;
  return provenance.sourcePath ?? candidate.source;
}

export function MetadataCandidateFieldControls({
  candidate,
  item,
  selectedFields,
  disabled = false,
  onToggle,
}: Readonly<{
  candidate: MetadataCandidate;
  item: LibraryItem;
  selectedFields: readonly MetadataCandidateField[];
  disabled?: boolean;
  onToggle: (field: MetadataCandidateField, checked: boolean) => void;
}>) {
  const fields = Object.keys(candidate.patch) as MetadataCandidateField[];
  return (
    <fieldset disabled={disabled}>
      <legend>Select fields to apply</legend>
      {fields.map((field) => (
        <label key={field} className="metadata-candidate-review__field">
          <input
            type="checkbox"
            checked={selectedFields.includes(field)}
            onChange={(event) => onToggle(field, event.currentTarget.checked)}
          />
          <span>
            <strong>{field}</strong>
            <small>Current: {displayValue(item[field as keyof LibraryItem])}</small>
            <small>Candidate: {displayValue(candidate.patch[field])}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
