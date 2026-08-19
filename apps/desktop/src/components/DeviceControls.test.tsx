import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DeviceControls,
  retainConnectedDeviceFormatPreferences,
  selectedDestinationAfterRefresh,
  setSessionDeviceFormatPreference,
} from "./DeviceControls";

const destination = {
  id: "reader",
  name: "Kindle",
  path: "/Volumes/Kindle",
  kind: "kindle",
} as const;

test("shows connection status first and keeps explicit format and device management in options", () => {
  const markup = renderToStaticMarkup(
    <DeviceControls
      actionsPending={false}
      destinations={[destination]}
      destinationsLoading={false}
      pendingAction={null}
      preferredFormat={null}
      selectedDestination={destination}
      selectedDestinationId={destination.id}
      onEject={async () => undefined}
      onRefresh={async () => undefined}
      onSelectDestination={() => undefined}
      onSelectPreferredFormat={() => undefined}
    />,
  );

  expect(markup).toContain("Kindle");
  expect(markup).toContain("Connected");
  expect(markup).toContain("<summary>Options</summary>");
  expect(markup).toContain("Preferred format");
  expect(markup).toContain('<option value="" selected="">Choose a format…</option>');
  expect(markup).toContain("Takio can convert a book when needed.");
  expect(markup).toContain("Check for readers");
  expect(markup).toContain("Eject Kindle");
  expect(markup).toContain('<option value="epub">EPUB</option>');
  expect(markup).toContain('<option value="pdf">PDF</option>');
});

test("turns an empty reader state into one clear next action", () => {
  const markup = renderToStaticMarkup(
    <DeviceControls
      actionsPending={false}
      destinations={[]}
      destinationsLoading={false}
      pendingAction={null}
      preferredFormat={null}
      selectedDestination={null}
      selectedDestinationId={null}
      onEject={async () => undefined}
      onRefresh={async () => undefined}
      onSelectDestination={() => undefined}
      onSelectPreferredFormat={() => undefined}
    />,
  );

  expect(markup).toContain("No reader connected");
  expect(markup).toContain("Connect one by USB and Takio will find it.");
  expect(markup).toContain(">Check again</button>");
  expect(markup).not.toContain("Preferred format");
  expect(markup).not.toContain("Eject");
});

test("keys session preferences by mount path and resets disconnected paths", () => {
  const firstPath = setSessionDeviceFormatPreference({}, "/Volumes/Reader A", "epub");
  const bothPaths = setSessionDeviceFormatPreference(firstPath, "/Volumes/Reader B", "pdf");

  expect(bothPaths).toEqual({
    "/Volumes/Reader A": "epub",
    "/Volumes/Reader B": "pdf",
  });
  expect(retainConnectedDeviceFormatPreferences(bothPaths, [destination])).toEqual({});
  expect(
    retainConnectedDeviceFormatPreferences(bothPaths, [
      { ...destination, path: "/Volumes/Reader B" },
    ]),
  ).toEqual({ "/Volumes/Reader B": "pdf" });
});

test("keeps a valid reader choice and automatically chooses the only connected reader", () => {
  expect(selectedDestinationAfterRefresh(null, [destination])).toBe(destination.id);
  expect(selectedDestinationAfterRefresh("reader", [destination])).toBe(destination.id);
  expect(
    selectedDestinationAfterRefresh("missing", [
      destination,
      { ...destination, id: "second", path: "/Volumes/Second" },
    ]),
  ).toBeNull();
  expect(selectedDestinationAfterRefresh(null, [])).toBeNull();
});
