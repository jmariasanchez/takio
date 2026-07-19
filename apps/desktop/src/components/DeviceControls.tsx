import type { Destination } from "@takio/core";

import { formatFileSize } from "../lib/format";

type DeviceControlsProps = {
  readonly actionsPending: boolean;
  readonly destinations: readonly Destination[];
  readonly destinationsLoading: boolean;
  readonly pendingAction: string | null;
  readonly selectedDestination: Destination | null;
  readonly selectedDestinationId: string | null;
  readonly onEject: () => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly onSelectDestination: (id: string | null) => void;
};

export function DeviceControls({
  actionsPending,
  destinations,
  destinationsLoading,
  pendingAction,
  selectedDestination,
  selectedDestinationId,
  onEject,
  onRefresh,
  onSelectDestination,
}: DeviceControlsProps) {
  return (
    <section className="reader-bar" aria-label="Connected readers">
      <div className="reader-heading">
        <p className="eyebrow">READER</p>
        <strong>Send to a mounted device</strong>
      </div>
      <div className="reader-controls">
        <select
          aria-label="Selected reader"
          value={selectedDestinationId ?? ""}
          disabled={actionsPending || destinationsLoading}
          onChange={(event) => onSelectDestination(event.currentTarget.value || null)}
        >
          <option value="">Choose a reader…</option>
          {destinations.map((destination) => (
            <option key={destination.id} value={destination.id}>
              {destination.name}
            </option>
          ))}
        </select>
        <span className="reader-detail" aria-live="polite">
          {destinationsLoading
            ? "Scanning…"
            : selectedDestination
              ? `${selectedDestination.kind[0]?.toUpperCase()}${selectedDestination.kind.slice(1)} · ${
                  selectedDestination.freeBytes === undefined
                    ? "Free space unavailable"
                    : `${formatFileSize(selectedDestination.freeBytes)} free`
                }`
              : `${destinations.length} ${destinations.length === 1 ? "reader" : "readers"} found`}
        </span>
        <button
          className="quiet-button"
          disabled={actionsPending || destinationsLoading}
          onClick={() => void onRefresh()}
        >
          {destinationsLoading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          className="quiet-button"
          disabled={!selectedDestination || actionsPending || destinationsLoading}
          onClick={() => void onEject()}
        >
          {pendingAction === "eject" ? "Ejecting…" : "Eject"}
        </button>
      </div>
    </section>
  );
}
