import {
  libraryHealthBackupRequestSchema,
  libraryHealthBackupValueSchema,
  libraryHealthDiagnosticsRequestSchema,
  libraryHealthDiagnosticsValueSchema,
  libraryHealthLocationSchema,
  libraryHealthVerifyValueSchema,
  type LibraryHealthBackupRequest,
  type LibraryHealthBackupWireResult,
  type LibraryHealthDiagnosticsRequest,
  type LibraryHealthDiagnosticsWireResult,
  type LibraryHealthErrorCode,
  type LibraryHealthLocationWireResult,
  type LibraryHealthVerifyWireResult,
} from "@takio/library-contract";

import { invoke } from "./desktop";
import type { LibraryInvoker } from "./library";

type BridgeFailure = {
  readonly ok: false;
  readonly error: { readonly code: LibraryHealthErrorCode | "engine-unavailable" | "protocol-error" };
};

export type DesktopLibraryHealthLocationResult = LibraryHealthLocationWireResult | BridgeFailure;
export type DesktopLibraryHealthVerifyResult = LibraryHealthVerifyWireResult | BridgeFailure;
export type DesktopLibraryHealthBackupResult = LibraryHealthBackupWireResult | BridgeFailure;
export type DesktopLibraryHealthDiagnosticsResult = LibraryHealthDiagnosticsWireResult | BridgeFailure;

const invokeDesktop: LibraryInvoker = (command, args) => invoke(command, args);

function protocolError(): BridgeFailure {
  return { ok: false, error: { code: "protocol-error" } };
}

function invalidArguments(): BridgeFailure {
  return { ok: false, error: { code: "invalid-arguments" } };
}

function isFailureCode(value: unknown): value is LibraryHealthErrorCode | BridgeFailure["error"]["code"] {
  return typeof value === "string" && value.length > 0;
}

function parseResult<T>(
  value: unknown,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: LibraryHealthErrorCode | BridgeFailure["error"]["code"] } } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return protocolError();
  }
  const record = value as { readonly ok?: unknown; readonly value?: unknown; readonly error?: { readonly code?: unknown } };
  if (record.ok === true) {
    const parsed = schema.safeParse(record.value);
    return parsed.success ? { ok: true, value: parsed.data } : protocolError();
  }
  if (record.ok === false && isFailureCode(record.error?.code)) {
    return { ok: false, error: { code: record.error.code } };
  }
  return protocolError();
}

export async function getLibraryHealthLocation(
  invoker: LibraryInvoker = invokeDesktop,
): Promise<DesktopLibraryHealthLocationResult> {
  return parseResult(await invoker<unknown>("library_health_location"), libraryHealthLocationSchema);
}

export async function verifyLibraryHealth(
  invoker: LibraryInvoker = invokeDesktop,
): Promise<DesktopLibraryHealthVerifyResult> {
  return parseResult(await invoker<unknown>("library_health_verify"), libraryHealthVerifyValueSchema);
}

export async function backUpLibrary(
  request: LibraryHealthBackupRequest,
  invoker: LibraryInvoker = invokeDesktop,
): Promise<DesktopLibraryHealthBackupResult> {
  const parsed = libraryHealthBackupRequestSchema.safeParse(request);
  if (!parsed.success) {
    return invalidArguments();
  }
  return parseResult(
    await invoker<unknown>("library_health_backup", parsed.data),
    libraryHealthBackupValueSchema,
  );
}

export async function exportLibraryDiagnostics(
  request: LibraryHealthDiagnosticsRequest,
  invoker: LibraryInvoker = invokeDesktop,
): Promise<DesktopLibraryHealthDiagnosticsResult> {
  const parsed = libraryHealthDiagnosticsRequestSchema.safeParse(request);
  if (!parsed.success) {
    return invalidArguments();
  }
  return parseResult(
    await invoker<unknown>("library_health_diagnostics", parsed.data),
    libraryHealthDiagnosticsValueSchema,
  );
}

export function describeLibraryHealthError(code: string): string {
  switch (code) {
    case "storage-unavailable":
      return "Takio could not open the current library storage.";
    case "incompatible-schema":
      return "This library uses an incompatible storage schema.";
    case "integrity-failed":
      return "Takio found a problem while checking the database or managed files.";
    case "destination-exists":
      return "A backup already exists at that destination. Choose another folder or try again.";
    case "backup-failed":
      return "Takio could not finish and verify the backup.";
    case "diagnostics-failed":
      return "Takio could not create the diagnostic bundle.";
    case "invalid-arguments":
      return "The library health request was not valid.";
    case "engine-unavailable":
      return "The local library engine is unavailable.";
    case "protocol-error":
      return "The local library engine returned an unexpected response.";
    default:
      return "Takio could not complete the library health request.";
  }
}
