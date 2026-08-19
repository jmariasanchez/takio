import { describe, expect, test } from "bun:test";

import {
  backUpLibrary,
  describeLibraryHealthError,
  getLibraryHealthLocation,
  verifyLibraryHealth,
} from "./library-health";
import type { LibraryInvoker } from "./library";

const report = {
  schemaVersion: 9,
  items: { total: 2, active: 2, trashed: 0 },
  formats: { total: 3, managed: 2, referenced: 1 },
};

describe("desktop library health bridge", () => {
  test("validates location, verify, and backup success payloads", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoker: LibraryInvoker = async (command, args) => {
      calls.push({ command, args });
      if (command === "library_health_location") {
        return { ok: true, value: { rootPath: "/Library/Takio", databasePath: "/Library/Takio/library.sqlite" } } as never;
      }
      if (command === "library_health_verify") {
        return { ok: true, value: { report } } as never;
      }
      return { ok: true, value: { backup: { path: "/Backups/takio", report } } } as never;
    };

    expect(await getLibraryHealthLocation(invoker)).toEqual({
      ok: true,
      value: { rootPath: "/Library/Takio", databasePath: "/Library/Takio/library.sqlite" },
    });
    expect(await verifyLibraryHealth(invoker)).toEqual({ ok: true, value: { report } });
    expect(await backUpLibrary({ destinationPath: "/Backups/takio" }, invoker)).toEqual({
      ok: true,
      value: { backup: { path: "/Backups/takio", report } },
    });
    expect(calls.map(({ command }) => command)).toEqual([
      "library_health_location",
      "library_health_verify",
      "library_health_backup",
    ]);
    expect(calls[2]?.args).toEqual({ destinationPath: "/Backups/takio" });
  });

  test("rejects invalid requests and malformed success payloads", async () => {
    const malformed: LibraryInvoker = async () => ({ ok: true, value: { report: { ...report, items: { total: 3, active: 2, trashed: 0 } } } } as never);

    expect(await backUpLibrary({ destinationPath: " " }, malformed)).toEqual({
      ok: false,
      error: { code: "invalid-arguments" },
    });
    expect(await verifyLibraryHealth(malformed)).toEqual({
      ok: false,
      error: { code: "protocol-error" },
    });
  });

  test("describes non-overwrite backup failures for users", () => {
    expect(describeLibraryHealthError("destination-exists")).toContain("already exists");
  });
});
