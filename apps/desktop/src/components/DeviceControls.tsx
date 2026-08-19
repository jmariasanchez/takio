import { FORMAT_CATALOG, type Destination, type FormatId } from "@takio/core";

import { formatFileSize } from "../lib/format";
import type { DestinationInventoryEntry } from "../lib/destinations";

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

export function selectedDestinationAfterRefresh(
  currentId: string | null,
  destinations: readonly Destination[],
): string | null {
  if (currentId && destinations.some(({ id }) => id === currentId)) {
    return currentId;
  }
  return destinations.length === 1 ? (destinations[0]?.id ?? null) : null;
}

type DeviceControlsProps = {
  readonly actionsPending: boolean;
  readonly destinations: readonly Destination[];
  readonly destinationsLoading: boolean;
  readonly convertIfNeeded: boolean;
  readonly pendingAction: string | null;
  readonly preferredFormat: FormatId | null;
  readonly inventoryEntries: readonly DestinationInventoryEntry[];
  readonly inventoryLoading: boolean;
  readonly selectedDestination: Destination | null;
  readonly selectedDestinationId: string | null;
  readonly onToggleConvertIfNeeded: (convertIfNeeded: boolean) => void;
  readonly onEject: () => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly onReconcile: () => Promise<void>;
  readonly onSelectDestination: (id: string | null) => void;
  readonly onSelectPreferredFormat: (format: FormatId | null) => void;
};

export function DeviceControls({
  actionsPending,
  destinations,
  destinationsLoading,
  convertIfNeeded,
  pendingAction,
  preferredFormat,
  inventoryEntries,
  inventoryLoading,
  selectedDestination,
  selectedDestinationId,
  onToggleConvertIfNeeded,
  onEject,
  onRefresh,
  onReconcile,
  onSelectDestination,
  onSelectPreferredFormat,
}: DeviceControlsProps) {
  const readerCountLabel = `${destinations.length} ${
    destinations.length === 1 ? "reader" : "readers"
  } found`;
  const visibleInventoryEntries = inventoryEntries.slice(0, 5);
  const inventorySummary = {
    present: inventoryEntries.filter((entry) => entry.status === "present").length,
    missing: inventoryEntries.filter((entry) => entry.status === "missing").length,
    changed: inventoryEntries.filter((entry) => entry.status === "changed").length,
  };

  return (
    <section className="reader-bar" aria-label="Connected readers">
      <div className="reader-heading">
        <span
          className={`reader-heading__status${selectedDestination ? " is-connected" : ""}`}
          aria-hidden="true"
        />
        <div>
          <p className="eyebrow">Reader</p>
          <strong>
            {destinationsLoading
              ? "Looking for a reader…"
              : selectedDestination
                ? selectedDestination.name
                : destinations.length > 0
                  ? "Choose a reader"
                  : "No reader connected"}
          </strong>
          <span className="reader-detail" aria-live="polite">
            {destinationsLoading
              ? "Checking USB devices"
              : selectedDestination
                ? `${
                    selectedDestination.freeBytes === undefined
                      ? "Connected"
                      : `${formatFileSize(selectedDestination.freeBytes)} available`
                  }`
                : destinations.length > 0
                  ? readerCountLabel
                  : "Connect one by USB and Takio will find it."}
          </span>
        </div>
      </div>

      {destinations.length > 0 ? (
        <label className="reader-picker">
          <span className="visually-hidden">Reader</span>
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
        </label>
      ) : null}

      <div className="reader-actions">
        {selectedDestination ? (
          <details className="reader-options">
            <summary>Options</summary>
            <div className="reader-options__panel">
              <label className="reader-format-preference">
                <span>Preferred format</span>
                <select
                  aria-describedby="reader-format-preference-help"
                  value={preferredFormat ?? ""}
                  disabled={actionsPending || destinationsLoading}
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
                Used when you choose Send. Takio can convert a book when needed.
              </small>
              <label className="reader-format-preference">
                <input
                  type="checkbox"
                  checked={convertIfNeeded}
                  disabled={actionsPending || destinationsLoading}
                  onChange={(event) => onToggleConvertIfNeeded(event.currentTarget.checked)}
                />
                <span>Convert if needed</span>
              </label>
              <small className="reader-format-preference-help">
                Takio can create a compatible copy before sending.
              </small>
              <button
                className="quiet-button reader-refresh"
                disabled={actionsPending || destinationsLoading}
                onClick={() => void onRefresh()}
              >
                {destinationsLoading ? "Checking…" : "Check for readers"}
              </button>
              <button
                className="quiet-button reader-refresh"
                disabled={actionsPending || destinationsLoading || inventoryLoading}
                onClick={() => void onReconcile()}
              >
                {inventoryLoading ? "Checking…" : "Recheck deliveries"}
              </button>
              <button
                className="quiet-button reader-eject"
                disabled={actionsPending || destinationsLoading}
                onClick={() => void onEject()}
              >
                {pendingAction === "eject" ? "Ejecting…" : `Eject ${selectedDestination.name}`}
              </button>
            </div>
          </details>
        ) : (
          <button
            className="quiet-button reader-refresh"
            disabled={actionsPending || destinationsLoading}
            onClick={() => void onRefresh()}
          >
            {destinationsLoading ? "Checking…" : "Check again"}
          </button>
        )}
      </div>

      {selectedDestination ? (
        <section className="reader-inventory" aria-label="Tracked reader deliveries">
          <div className="reader-inventory__summary" aria-live="polite">
            <span>{inventorySummary.present} present</span>
            <span>{inventorySummary.missing} missing</span>
            <span>{inventorySummary.changed} changed</span>
          </div>
          {inventoryEntries.length === 0 ? (
            <p className="reader-detail">
              {inventoryLoading ? "Checking tracked deliveries…" : "No tracked deliveries on this reader."}
            </p>
          ) : (
            <ul className="reader-inventory__list">
              {visibleInventoryEntries.map((entry) => (
                <li key={`${entry.itemId}:${entry.relativePath}`}>
                  <strong>{entry.status}</strong>
                  <span>{entry.relativePath}</span>
                  <small>{entry.format.toUpperCase()} · {formatFileSize(entry.bytes)}</small>
                </li>
              ))}
            </ul>
          )}
          {inventoryEntries.length > visibleInventoryEntries.length ? (
            <small className="reader-detail">
              Showing {visibleInventoryEntries.length} of {inventoryEntries.length} tracked deliveries.
            </small>
          ) : null}
        </section>
      ) : null}

    </section>
  );
}
