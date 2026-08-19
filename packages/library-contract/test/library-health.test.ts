import { describe, expect, test } from "bun:test";

import {
  libraryHealthBackupRequestSchema,
  libraryHealthBackupValueSchema,
  libraryHealthLocationSchema,
  libraryHealthVerifyValueSchema,
  libraryIntegrityReportSchema,
} from "../src/index.js";

const report = {
  schemaVersion: 9,
  items: { total: 3, active: 2, trashed: 1 },
  formats: { total: 5, managed: 3, referenced: 2 },
};

describe("library health contract", () => {
  test("accepts stable location, verify, and backup payloads", () => {
    expect(libraryHealthLocationSchema.parse({
      rootPath: "/Users/example/Library/Application Support/Takio",
      databasePath: "/Users/example/Library/Application Support/Takio/library.sqlite",
    }).rootPath).toContain("Takio");
    expect(libraryHealthVerifyValueSchema.parse({ report }).report.items.active).toBe(2);
    expect(libraryHealthBackupRequestSchema.parse({ destinationPath: "/Backups/takio" })).toEqual({
      destinationPath: "/Backups/takio",
    });
    expect(libraryHealthBackupValueSchema.parse({
      backup: { path: "/Backups/takio", report },
    }).backup.report.formats.referenced).toBe(2);
  });

  test("rejects impossible count totals and blank backup destinations", () => {
    expect(libraryIntegrityReportSchema.safeParse({
      ...report,
      formats: { total: 5, managed: 5, referenced: 5 },
    }).success).toBe(false);
    expect(libraryHealthBackupRequestSchema.safeParse({ destinationPath: " " }).success).toBe(false);
  });
});
