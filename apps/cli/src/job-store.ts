import { Database } from "bun:sqlite";
import { FORMAT_IDS, type FormatId } from "@takio/core";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type ConversionJob = {
  readonly id: string;
  readonly status: JobStatus;
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

type StoredJob = {
  id: unknown;
  status: unknown;
  inputPath: unknown;
  inputFormat: unknown;
  outputFormat: unknown;
  outputPath: unknown;
  createdAt: unknown;
  startedAt: unknown;
  finishedAt: unknown;
  ownerPid: unknown;
  errorCode: unknown;
  artifactBytes: unknown;
  artifactSha256: unknown;
};

export type JobStoreErrorCode =
  | "storage-unavailable"
  | "incompatible-schema"
  | "invalid-stored-data"
  | "artifact-invalid"
  | "unknown-job"
  | "invalid-transition";

export type JobStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: JobStoreErrorCode } };

const selectJob = `
  SELECT id, status, input_path AS inputPath, input_format AS inputFormat,
    output_format AS outputFormat, output_path AS outputPath,
    created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
    owner_pid AS ownerPid, error_code AS errorCode,
    artifact_bytes AS artifactBytes, artifact_sha256 AS artifactSha256
  FROM jobs
`;

const incompatibleSchema = Symbol("incompatible-schema");

function success<T>(value: T): JobStoreResult<T> {
  return { ok: true, value };
}

function failure<T>(code: JobStoreErrorCode): JobStoreResult<T> {
  return { ok: false, error: { code } };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isFormat(value: unknown): value is FormatId {
  return typeof value === "string" && FORMAT_IDS.includes(value as FormatId);
}

function readJob(row: StoredJob): JobStoreResult<ConversionJob> {
  if (
    typeof row.id !== "string" || !row.id.startsWith("job_") ||
    !JOB_STATUSES.includes(row.status as JobStatus) ||
    typeof row.inputPath !== "string" || !isAbsolute(row.inputPath) ||
    !isFormat(row.inputFormat) || !isFormat(row.outputFormat) ||
    typeof row.outputPath !== "string" || !isAbsolute(row.outputPath) ||
    !isTimestamp(row.createdAt)
  ) {
    return failure("invalid-stored-data");
  }

  const base = {
    id: row.id,
    status: row.status as JobStatus,
    inputPath: row.inputPath,
    inputFormat: row.inputFormat,
    outputFormat: row.outputFormat,
    outputPath: row.outputPath,
    createdAt: row.createdAt,
  };
  const absent = (value: unknown) => value === null;

  if (row.status === "queued") {
    return [row.startedAt, row.finishedAt, row.ownerPid, row.errorCode, row.artifactBytes, row.artifactSha256].every(absent)
      ? success(base)
      : failure("invalid-stored-data");
  }
  if (row.status === "running") {
    return isTimestamp(row.startedAt) && Number.isSafeInteger(row.ownerPid) && (row.ownerPid as number) > 0 &&
      [row.finishedAt, row.errorCode, row.artifactBytes, row.artifactSha256].every(absent)
      ? success({ ...base, startedAt: row.startedAt, ownerPid: row.ownerPid as number })
      : failure("invalid-stored-data");
  }
  if (row.status === "completed") {
    return isTimestamp(row.startedAt) && isTimestamp(row.finishedAt) && absent(row.ownerPid) &&
      absent(row.errorCode) && Number.isSafeInteger(row.artifactBytes) && (row.artifactBytes as number) > 0 &&
      typeof row.artifactSha256 === "string" && /^[a-f0-9]{64}$/.test(row.artifactSha256)
      ? success({
          ...base,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          artifact: {
            path: row.outputPath,
            bytes: row.artifactBytes as number,
            sha256: row.artifactSha256,
          },
        })
      : failure("invalid-stored-data");
  }
  if (row.status === "failed") {
    return isTimestamp(row.startedAt) && isTimestamp(row.finishedAt) && absent(row.ownerPid) &&
      typeof row.errorCode === "string" && row.errorCode.length > 0 &&
      absent(row.artifactBytes) && absent(row.artifactSha256)
      ? success({
          ...base,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          errorCode: row.errorCode,
        })
      : failure("invalid-stored-data");
  }
  return absent(row.startedAt) && isTimestamp(row.finishedAt) &&
    [row.ownerPid, row.errorCode, row.artifactBytes, row.artifactSha256].every(absent)
    ? success({ ...base, finishedAt: row.finishedAt })
    : failure("invalid-stored-data");
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function artifactMatches(
  path: string,
  expected: { bytes: number; sha256: string },
): Promise<boolean> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const initial = await file.stat();
    if (!initial.isFile() || initial.size === 0 || initial.size !== expected.bytes) {
      return false;
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const result = await file.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > expected.bytes) return false;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const final = await file.stat();
    return bytes === expected.bytes && final.size === expected.bytes && hash.digest("hex") === expected.sha256;
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => {});
  }
}

export class JobStore {
  #database: Database | null = null;

  constructor(
    readonly databasePath: string,
    private readonly isOwnerAlive: (pid: number) => boolean = ownerIsAlive,
  ) {
    if (databasePath.length === 0) {
      throw new TypeError("A database path is required.");
    }
  }

  open(): JobStoreResult<null> {
    if (this.#database) return success(null);
    let database: Database | null = null;
    try {
      database = new Database(this.databasePath, { create: true, strict: true });
      database.run("PRAGMA busy_timeout = 5000");
      database.transaction(() => {
        const version = database!.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
        if (version === 0) {
          const existing = database!.query<{ present: number }, []>(
            "SELECT 1 AS present FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1",
          ).get();
          if (existing) throw incompatibleSchema;
          database!.run(`
            CREATE TABLE jobs (
              enqueue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL UNIQUE,
              status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','canceled')),
              input_path TEXT NOT NULL,
              input_format TEXT NOT NULL,
              output_format TEXT NOT NULL,
              output_path TEXT NOT NULL,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT,
              owner_pid INTEGER,
              error_code TEXT,
              artifact_bytes INTEGER,
              artifact_sha256 TEXT
            ) STRICT
          `);
          database!.run("CREATE INDEX jobs_status_order ON jobs(status, enqueue_sequence)");
          database!.run("PRAGMA user_version = 1");
        } else if (version !== 1) {
          throw incompatibleSchema;
        }
      }).immediate();
      this.#database = database;
      const recovered = this.#recoverStaleJobs();
      if (!recovered.ok) {
        this.close();
        return recovered;
      }
      return success(null);
    } catch (error) {
      database?.close();
      return failure(error === incompatibleSchema ? "incompatible-schema" : "storage-unavailable");
    }
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }

  enqueue(input: {
    inputPath: string;
    inputFormat: FormatId;
    outputFormat: FormatId;
    outputPath: string;
  }): JobStoreResult<ConversionJob> {
    if (!this.#database) return failure("storage-unavailable");
    if (
      !isAbsolute(input.inputPath) || !isAbsolute(input.outputPath) ||
      !isFormat(input.inputFormat) || !isFormat(input.outputFormat)
    ) {
      return failure("invalid-stored-data");
    }
    const id = `job_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    try {
      this.#database.transaction(() => this.#database!.run(
        `INSERT INTO jobs (id, status, input_path, input_format, output_format, output_path, created_at)
         VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
        [id, input.inputPath, input.inputFormat, input.outputFormat, input.outputPath, createdAt],
      )).immediate();
      return this.get(id) as JobStoreResult<ConversionJob>;
    } catch {
      return failure("storage-unavailable");
    }
  }

  list(status?: JobStatus): JobStoreResult<ConversionJob[]> {
    if (!this.#database) return failure("storage-unavailable");
    try {
      const rows = status
        ? this.#database.query<StoredJob, [JobStatus]>(`${selectJob} WHERE status = ? ORDER BY enqueue_sequence`).all(status)
        : this.#database.query<StoredJob, []>(`${selectJob} ORDER BY enqueue_sequence`).all();
      const jobs: ConversionJob[] = [];
      for (const row of rows) {
        const job = readJob(row);
        if (!job.ok) return job;
        jobs.push(job.value);
      }
      return success(jobs);
    } catch {
      return failure("storage-unavailable");
    }
  }

  get(id: string): JobStoreResult<ConversionJob | null> {
    if (!this.#database) return failure("storage-unavailable");
    try {
      const row = this.#database.query<StoredJob, [string]>(`${selectJob} WHERE id = ?`).get(id);
      return row ? readJob(row) : success(null);
    } catch {
      return failure("storage-unavailable");
    }
  }

  claimNext(pid: number = process.pid): JobStoreResult<ConversionJob | null> {
    if (!this.#database) return failure("storage-unavailable");
    if (!Number.isSafeInteger(pid) || pid <= 0) return failure("invalid-stored-data");
    const startedAt = new Date().toISOString();
    try {
      const row = this.#database.transaction(() => this.#database!.query<StoredJob, [string, number]>(`
        UPDATE jobs SET status = 'running', started_at = ?, owner_pid = ?
        WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY enqueue_sequence LIMIT 1)
          AND status = 'queued'
        RETURNING id, status, input_path AS inputPath, input_format AS inputFormat,
          output_format AS outputFormat, output_path AS outputPath,
          created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
          owner_pid AS ownerPid, error_code AS errorCode,
          artifact_bytes AS artifactBytes, artifact_sha256 AS artifactSha256
      `).get(startedAt, pid)).immediate();
      return row ? readJob(row) : success(null);
    } catch {
      return failure("storage-unavailable");
    }
  }

  async complete(
    id: string,
    artifact: { path: string; bytes: number; sha256: string },
  ): Promise<JobStoreResult<ConversionJob>> {
    const current = this.get(id);
    if (!current.ok) return current;
    if (!current.value) return failure("unknown-job");
    if (current.value.status !== "running") return failure("invalid-transition");
    if (
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      return failure("artifact-invalid");
    }
    if (
      artifact.path !== current.value.outputPath ||
      !(await artifactMatches(current.value.outputPath, artifact))
    ) {
      return failure("artifact-invalid");
    }
    return this.#finish(id, "completed", null, artifact);
  }

  fail(id: string, errorCode: string): JobStoreResult<ConversionJob> {
    if (errorCode.length === 0) return failure("invalid-stored-data");
    return this.#finish(id, "failed", errorCode, null);
  }

  cancel(id: string): JobStoreResult<ConversionJob> {
    if (!this.#database) return failure("storage-unavailable");
    try {
      return this.#database.transaction(() => {
        const finishedAt = new Date().toISOString();
        const row = this.#database!.query<StoredJob, [string, string]>(`
          UPDATE jobs SET status = 'canceled', finished_at = ?
          WHERE id = ? AND status = 'queued'
          RETURNING id, status, input_path AS inputPath, input_format AS inputFormat,
            output_format AS outputFormat, output_path AS outputPath,
            created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
            owner_pid AS ownerPid, error_code AS errorCode,
            artifact_bytes AS artifactBytes, artifact_sha256 AS artifactSha256
        `).get(finishedAt, id);
        if (row) return readJob(row);
        return this.#database!.query<{ present: number }, [string]>("SELECT 1 AS present FROM jobs WHERE id = ?").get(id)
          ? failure<ConversionJob>("invalid-transition")
          : failure<ConversionJob>("unknown-job");
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }
  }

  #finish(
    id: string,
    status: "completed" | "failed",
    errorCode: string | null,
    artifact: { bytes: number; sha256: string } | null,
  ): JobStoreResult<ConversionJob> {
    if (!this.#database) return failure("storage-unavailable");
    try {
      return this.#database.transaction(() => {
        const row = this.#database!.query<StoredJob, [string, string, string | null, number | null, string | null, string]>(`
          UPDATE jobs SET status = ?, finished_at = ?, owner_pid = NULL, error_code = ?,
            artifact_bytes = ?, artifact_sha256 = ?
          WHERE id = ? AND status = 'running'
          RETURNING id, status, input_path AS inputPath, input_format AS inputFormat,
            output_format AS outputFormat, output_path AS outputPath,
            created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
            owner_pid AS ownerPid, error_code AS errorCode,
            artifact_bytes AS artifactBytes, artifact_sha256 AS artifactSha256
        `).get(status, new Date().toISOString(), errorCode, artifact?.bytes ?? null, artifact?.sha256 ?? null, id);
        if (row) return readJob(row);
        return this.#database!.query<{ present: number }, [string]>("SELECT 1 AS present FROM jobs WHERE id = ?").get(id)
          ? failure<ConversionJob>("invalid-transition")
          : failure<ConversionJob>("unknown-job");
      }).immediate();
    } catch {
      return failure("storage-unavailable");
    }
  }

  #recoverStaleJobs(): JobStoreResult<null> {
    if (!this.#database) return failure("storage-unavailable");
    try {
      const running = this.#database.query<StoredJob, []>(
        `${selectJob} WHERE status = 'running' ORDER BY enqueue_sequence`,
      ).all();
      const stale: ConversionJob[] = [];
      for (const row of running) {
        const job = readJob(row);
        if (!job.ok) return job;
        if (!this.isOwnerAlive(job.value.ownerPid!)) stale.push(job.value);
      }
      if (stale.length > 0) {
        this.#database.transaction(() => {
          const statement = this.#database!.query(
            "UPDATE jobs SET status = 'failed', finished_at = ?, owner_pid = NULL, error_code = 'interrupted' WHERE id = ? AND status = 'running'",
          );
          const finishedAt = new Date().toISOString();
          for (const job of stale) statement.run(finishedAt, job.id);
        }).immediate();
      }
      return success(null);
    } catch {
      return failure("storage-unavailable");
    }
  }
}
