import { invoke } from "@tauri-apps/api/core";
import { FORMAT_IDS, type FormatId } from "@takio/core";

export const JOB_STATUSES = ["queued", "running", "completed", "failed", "canceled"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobAttachment =
  | { readonly status: "pending" }
  | { readonly status: "attached"; readonly finishedAt: string }
  | { readonly status: "failed"; readonly errorCode: string; readonly finishedAt: string };

export type ConversionJob = {
  readonly id: string;
  readonly status: JobStatus;
  readonly libraryItemId?: string;
  readonly attachment?: JobAttachment;
  readonly inputPath: string;
  readonly inputFormat: FormatId;
  readonly outputFormat: FormatId;
  readonly outputPath: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly ownerPid?: number;
  readonly errorCode?: string;
  readonly artifact?: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  };
};

type JobFailure = {
  readonly ok: false;
  readonly error: { readonly code: string };
};

export type DesktopJobListResult =
  | { readonly ok: true; readonly value: { readonly jobs: readonly ConversionJob[] } }
  | JobFailure;

export type DesktopJobResult =
  | { readonly ok: true; readonly value: { readonly job: ConversionJob } }
  | JobFailure;

export type DesktopJobRunNextResult =
  | { readonly ok: true; readonly value: { readonly job: ConversionJob | null } }
  | JobFailure;

export type EnqueueConversionJobRequest =
  | {
      readonly inputPath: string;
      readonly outputFormat: FormatId;
      readonly outputPath: string;
    }
  | {
      readonly libraryItemId: string;
      readonly inputFormat: FormatId;
      readonly outputFormat: FormatId;
      readonly outputPath: string;
    };

export type JobInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const invokeTauri: JobInvoker = (command, args) => invoke(command, args);
const protocolFailure = { ok: false, error: { code: "protocol-error" } } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonemptyString(value) && !Number.isNaN(Date.parse(value));
}

function isFormat(value: unknown): value is FormatId {
  return typeof value === "string" && FORMAT_IDS.includes(value as FormatId);
}

function isFailure(value: unknown): value is JobFailure {
  return (
    isRecord(value) &&
    value.ok === false &&
    isRecord(value.error) &&
    isNonemptyString(value.error.code)
  );
}

function readAttachment(value: unknown): JobAttachment | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.status === "pending") {
    return value.finishedAt === undefined && value.errorCode === undefined
      ? { status: "pending" }
      : null;
  }
  if (value.status === "attached") {
    return isTimestamp(value.finishedAt) && value.errorCode === undefined
      ? { status: "attached", finishedAt: value.finishedAt }
      : null;
  }
  if (value.status === "failed") {
    return isTimestamp(value.finishedAt) && isNonemptyString(value.errorCode)
      ? { status: "failed", errorCode: value.errorCode, finishedAt: value.finishedAt }
      : null;
  }
  return null;
}

function readJob(value: unknown): ConversionJob | null {
  if (
    !isRecord(value) ||
    !isNonemptyString(value.id) ||
    !value.id.startsWith("job_") ||
    !JOB_STATUSES.includes(value.status as JobStatus) ||
    (value.libraryItemId !== undefined && !isNonemptyString(value.libraryItemId)) ||
    !isNonemptyString(value.inputPath) ||
    !isFormat(value.inputFormat) ||
    !isFormat(value.outputFormat) ||
    !isNonemptyString(value.outputPath) ||
    !isTimestamp(value.createdAt)
  ) {
    return null;
  }

  const base = {
    id: value.id,
    status: value.status as JobStatus,
    ...(typeof value.libraryItemId === "string" ? { libraryItemId: value.libraryItemId } : {}),
    inputPath: value.inputPath,
    inputFormat: value.inputFormat,
    outputFormat: value.outputFormat,
    outputPath: value.outputPath,
    createdAt: value.createdAt,
  };
  const absent = (field: unknown) => field === undefined;

  if (value.status === "queued") {
    return [
      value.startedAt,
      value.finishedAt,
      value.ownerPid,
      value.errorCode,
      value.artifact,
      value.attachment,
    ].every(absent)
      ? base
      : null;
  }

  if (value.status === "running") {
    return isTimestamp(value.startedAt) &&
      Number.isSafeInteger(value.ownerPid) &&
      (value.ownerPid as number) > 0 &&
      [value.finishedAt, value.errorCode, value.artifact, value.attachment].every(absent)
      ? { ...base, startedAt: value.startedAt, ownerPid: value.ownerPid as number }
      : null;
  }

  if (value.status === "completed") {
    if (
      !isTimestamp(value.startedAt) ||
      !isTimestamp(value.finishedAt) ||
      !absent(value.ownerPid) ||
      !absent(value.errorCode) ||
      !isRecord(value.artifact) ||
      value.artifact.path !== value.outputPath ||
      !Number.isSafeInteger(value.artifact.bytes) ||
      (value.artifact.bytes as number) <= 0 ||
      typeof value.artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.artifact.sha256)
    ) {
      return null;
    }
    const attachment = readAttachment(value.attachment);
    if (
      (typeof value.libraryItemId === "string" && attachment === null) ||
      (value.libraryItemId === undefined && !absent(value.attachment))
    ) {
      return null;
    }
    return {
      ...base,
      ...(attachment ? { attachment } : {}),
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      artifact: {
        path: value.artifact.path,
        bytes: value.artifact.bytes as number,
        sha256: value.artifact.sha256,
      },
    };
  }

  if (value.status === "failed") {
    return isTimestamp(value.startedAt) &&
      isTimestamp(value.finishedAt) &&
      absent(value.ownerPid) &&
      isNonemptyString(value.errorCode) &&
      [value.artifact, value.attachment].every(absent)
      ? {
          ...base,
          startedAt: value.startedAt,
          finishedAt: value.finishedAt,
          errorCode: value.errorCode,
        }
      : null;
  }

  return absent(value.startedAt) &&
    isTimestamp(value.finishedAt) &&
    [value.ownerPid, value.errorCode, value.artifact, value.attachment].every(absent)
    ? { ...base, finishedAt: value.finishedAt }
    : null;
}

export async function listConversionJobs(
  invokeCommand: JobInvoker = invokeTauri,
): Promise<DesktopJobListResult> {
  const result: unknown = await invokeCommand("jobs_list");
  if (isFailure(result)) {
    return result;
  }
  if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) {
    return protocolFailure;
  }
  const records = result.value.jobs;
  if (!Array.isArray(records)) {
    return protocolFailure;
  }
  const jobs = records.map(readJob);
  return jobs.every((job): job is ConversionJob => job !== null)
    ? { ok: true, value: { jobs } }
    : protocolFailure;
}

async function invokeJobMutation(
  command: string,
  args: Record<string, unknown> | undefined,
  invokeCommand: JobInvoker,
): Promise<DesktopJobResult> {
  const result: unknown = await invokeCommand(command, args);
  if (isFailure(result)) {
    return result;
  }
  if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) {
    return protocolFailure;
  }
  const job = readJob(result.value.job);
  return job ? { ok: true, value: { job } } : protocolFailure;
}

export function enqueueConversionJob(
  request: EnqueueConversionJobRequest,
  invokeCommand: JobInvoker = invokeTauri,
): Promise<DesktopJobResult> {
  const args =
    "libraryItemId" in request
      ? {
          libraryItemId: request.libraryItemId,
          from: request.inputFormat,
          to: request.outputFormat,
          output: request.outputPath,
        }
      : {
          input: request.inputPath,
          to: request.outputFormat,
          output: request.outputPath,
        };
  return invokeJobMutation("jobs_enqueue", args, invokeCommand);
}

export async function runNextConversionJob(
  invokeCommand: JobInvoker = invokeTauri,
): Promise<DesktopJobRunNextResult> {
  const result: unknown = await invokeCommand("jobs_run_next");
  if (isFailure(result)) {
    return result;
  }
  if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) {
    return protocolFailure;
  }
  if (result.value.job === null) {
    return { ok: true, value: { job: null } };
  }
  const job = readJob(result.value.job);
  return job ? { ok: true, value: { job } } : protocolFailure;
}

export function cancelConversionJob(
  id: string,
  invokeCommand: JobInvoker = invokeTauri,
): Promise<DesktopJobResult> {
  return invokeJobMutation("jobs_cancel", { id }, invokeCommand);
}

export function describeJobError(code: string): string {
  switch (code) {
    case "invalid-arguments":
      return "The conversion request is invalid.";
    case "backend-unavailable":
      return "The Calibre conversion engine is unavailable.";
    case "source-unavailable":
      return "The source book is unavailable.";
    case "unsupported-conversion":
      return "That format conversion is not supported.";
    case "output-file-exists":
      return "A file already exists at the selected output location.";
    case "conversion-timeout":
      return "The conversion took too long and was stopped.";
    case "conversion-cancelled":
      return "The conversion engine stopped before finishing.";
    case "artifact-invalid":
      return "The converted file could not be verified.";
    case "copy-failed":
      return "The converted file could not be saved.";
    case "unknown-job":
      return "That conversion job no longer exists.";
    case "invalid-transition":
      return "That conversion can no longer be changed.";
    case "engine-unavailable":
      return "The local conversion service is unavailable.";
    case "protocol-error":
      return "The local conversion service returned an invalid response.";
    case "invalid-stored-data":
      return "The conversion list contains data Takio cannot read.";
    case "incompatible-schema":
      return "The conversion list was created by an incompatible Takio version.";
    case "storage-unavailable":
      return "The conversion list is unavailable.";
    case "conversion-failed":
    default:
      return "The conversion could not be completed.";
  }
}

export function describeUnexpectedJobError(_error: unknown): string {
  return "The conversion service is unavailable.";
}
