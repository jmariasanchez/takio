import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DeviceControls,
  retainConnectedDeviceFormatPreferences,
  setSessionDeviceFormatPreference,
} from "./DeviceControls";

const destination = {
  id: "reader",
  name: "Kindle",
  path: "/Volumes/Kindle",
  kind: "kindle",
} as const;

test("requires an explicit session format without inferring one from the reader kind", () => {
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

  expect(markup).toContain("Send format (this session)");
  expect(markup).toContain('<option value="" selected="">Choose a format…</option>');
  expect(markup).toContain("Resets when this reader disconnects or Takio closes.");
  expect(markup).toContain('<option value="epub">EPUB</option>');
  expect(markup).toContain('<option value="pdf">PDF</option>');
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
