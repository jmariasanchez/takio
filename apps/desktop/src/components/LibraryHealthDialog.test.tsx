import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  backupDirectoryName,
  LibraryHealthDialog,
} from "./LibraryHealthDialog";

const report = {
  schemaVersion: 9,
  items: { total: 4, active: 3, trashed: 1 },
  formats: { total: 6, managed: 4, referenced: 2 },
};

function render(overrides: Partial<Parameters<typeof LibraryHealthDialog>[0]> = {}): string {
  return renderToStaticMarkup(
    <LibraryHealthDialog
      open
      location={{ rootPath: "/Users/me/Library/Application Support/Takio", databasePath: "/Users/me/Library/Application Support/Takio/library.sqlite" }}
      loadingLocation={false}
      lastVerification={{ checkedAt: "2026-08-19T21:00:00.000Z", report }}
      verificationError={null}
      backupResult={null}
      backupError={null}
      pendingAction={null}
      onClose={() => undefined}
      onVerify={() => undefined}
      onBackup={() => undefined}
      {...overrides}
    />,
  );
}

test("renders storage location, session verification counts, and format facts", () => {
  const markup = render();

  expect(markup).toContain('role="dialog" aria-modal="true"');
  expect(markup).toContain("Library Health");
  expect(markup).toContain("/Users/me/Library/Application Support/Takio");
  expect(markup).toContain("Last verified this session");
  for (const text of ["4", "3", "1", "6", "Managed formats", "Referenced formats"]) {
    expect(markup).toContain(text);
  }
  expect(markup).toContain("Managed formats are Takio-owned files included in backups");
  expect(markup).toContain("Verify now");
  expect(markup).toContain("Back up...");
});

test("renders pending, error, and backup result states", () => {
  const markup = render({
    pendingAction: "backup",
    verificationError: "Integrity failed.",
    backupError: "A backup already exists.",
    backupResult: { path: "/Backups/takio", report },
  });

  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain("Backing up...");
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Backup complete");
  expect(markup).toContain("/Backups/takio");
});

test("does not render while closed and creates stable absent-destination names", () => {
  expect(render({ open: false })).toBe("");
  expect(backupDirectoryName(new Date("2026-08-19T21:00:00.123Z"))).toBe(
    "takio-library-backup-2026-08-19T21-00-00-123Z",
  );
});
