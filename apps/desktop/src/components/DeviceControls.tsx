import { FORMAT_CATALOG, type Destination, type FormatId } from "@takio/core";

import { formatFileSize } from "../lib/format";

export type SessionDeviceFormatPreferences = Readonly<Record<string, FormatId>>;

export function setSessionDeviceFormatPreference(
  preferences: SessionDeviceFormatPreferences,
  destinationPath: string,
  format: FormatId | null,
): SessionDeviceFormatPreferences {
  const nextPreferences = { ...preferences };
  if (format === null) {
    delete nextPreferences[destinationPath];
  } else {
    nextPreferences[destinationPath] = format;
  }
  return nextPreferences;
}

export function retainConnectedDeviceFormatPreferences(
  preferences: SessionDeviceFormatPreferences,
  destinations: readonly Destination[],
): SessionDeviceFormatPreferences {
  const connectedPaths = new Set(destinations.map((destination) => destination.path));
  const retainedPreferences = Object.fromEntries(
    Object.entries(preferences).filter(([path]) => connectedPaths.has(path)),
  ) as Record<string, FormatId>;
  return Object.keys(retainedPreferences).length === Object.keys(preferences).length
    ? preferences
    : retainedPreferences;
}

type DeviceControlsProps = {
  readonly actionsPending: boolean;
  readonly destinations: readonly Destination[];
  readonly destinationsLoading: boolean;
  readonly pendingAction: string | null;
  readonly preferredFormat: FormatId | null;
  readonly selectedDestination: Destination | null;
  readonly selectedDestinationId: string | null;
  readonly onEject: () => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly onSelectDestination: (id: string | null) => void;
  readonly onSelectPreferredFormat: (format: FormatId | null) => void;
};

export function DeviceControls({
  actionsPending,
  destinations,
  destinationsLoading,
  pendingAction,
  preferredFormat,
  selectedDestination,
  selectedDestinationId,
  onEject,
  onRefresh,
  onSelectDestination,
  onSelectPreferredFormat,
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
        <label className="reader-format-preference">
          <span>Send format (this session)</span>
          <select
            aria-describedby="reader-format-preference-help"
            value={preferredFormat ?? ""}
            disabled={!selectedDestination || actionsPending || destinationsLoading}
            onChange={(event) =>
              onSelectPreferredFormat((event.currentTarget.value || null) as FormatId | null)
            }
          >
            <option value="">Choose a format…</option>
            {FORMAT_CATALOG.map((format) => (
              <option key={format.id} value={format.id}>
                {format.label}
              </option>
            ))}
          </select>
        </label>
        <small className="reader-format-preference-help" id="reader-format-preference-help">
          Used for general Send actions. Resets when this reader disconnects or Takio closes.
        </small>
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
