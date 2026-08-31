import { describe, expect, test } from "bun:test";

import {
  LIBRARY_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  MAX_LIBRARY_DIAGNOSTIC_BUNDLE_BYTES,
  libraryDiagnosticBundleSchema,
  libraryHealthBackupRequestSchema,
  libraryHealthBackupValueSchema,
  libraryHealthDiagnosticsRequestSchema,
  libraryHealthDiagnosticsValueSchema,
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

  test("accepts a bounded path-free redacted diagnostics bundle", () => {
    const generatedAt = "2026-08-31T13:00:00.000Z";
    const bundle = {
      schemaVersion: LIBRARY_DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
      generatedAt,
      application: {
        name: "takio",
        version: "0.1.0",
        implementation: "rust",
        platform: "darwin",
        architecture: "arm64",
      },
      library: {
        verification: { status: "ok", report },
        storage: {
          database: { present: true, bytes: 4096 },
          jobsDatabase: { present: false, bytes: 0 },
          managedItems: { files: 3, bytes: 12345, scanComplete: true },
          covers: { files: 1, bytes: 321, scanComplete: true },
        },
      },
      capabilities: {
        tui: true,
        contentServerLocal: true,
        contentServerRemoteTls: false,
        metadataCandidateCovers: true,
      },
      redaction: {
        paths: "omitted",
        ebookContents: "omitted",
        secrets: "omitted",
      },
    } as const;

    expect(libraryDiagnosticBundleSchema.parse(bundle)).toEqual(bundle);
    expect(libraryHealthDiagnosticsRequestSchema.parse({ destinationPath: "/Support/takio.json" }))
      .toEqual({ destinationPath: "/Support/takio.json" });
    expect(libraryHealthDiagnosticsValueSchema.parse({
      diagnostics: {
        path: "/Support/takio.json",
        bytes: 4096,
        sha256: "a".repeat(64),
        generatedAt,
        verificationStatus: "ok",
      },
    }).diagnostics.bytes).toBe(4096);
    expect(MAX_LIBRARY_DIAGNOSTIC_BUNDLE_BYTES).toBe(1024 * 1024);
  });

  test("rejects paths, unknown fields, inconsistent file state, and oversized result metadata", () => {
    const failed = {
      schemaVersion: 1,
      generatedAt: "2026-08-31T13:00:00.000Z",
      application: {
        name: "takio",
        version: "0.1.0",
        implementation: "rust",
        platform: "darwin",
        architecture: "arm64",
      },
      library: {
        verification: { status: "failed", errorCode: "incompatible-schema" },
        storage: {
          database: { present: false, bytes: 1 },
          jobsDatabase: { present: false, bytes: 0 },
          managedItems: { files: 0, bytes: 0, scanComplete: false },
          covers: { files: 0, bytes: 0, scanComplete: false },
        },
      },
      capabilities: {
        tui: true,
        contentServerLocal: true,
        contentServerRemoteTls: false,
        metadataCandidateCovers: true,
      },
      redaction: { paths: "omitted", ebookContents: "omitted", secrets: "omitted" },
      rootPath: "/private/library",
    };

    expect(libraryDiagnosticBundleSchema.safeParse(failed).success).toBe(false);
    expect(libraryHealthDiagnosticsRequestSchema.safeParse({ destinationPath: " " }).success).toBe(false);
    expect(libraryHealthDiagnosticsValueSchema.safeParse({
      diagnostics: {
        path: "/Support/takio.json",
        bytes: MAX_LIBRARY_DIAGNOSTIC_BUNDLE_BYTES + 1,
        sha256: "a".repeat(64),
        generatedAt: "2026-08-31T13:00:00.000Z",
        verificationStatus: "failed",
      },
    }).success).toBe(false);
  });
});
