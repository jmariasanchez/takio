import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { BunSqliteLibraryStore } from "@takio/library-store-bun";

import { JobStore, type ConversionJob, type JobStoreResult } from "./job-store.js";

type Artifact = NonNullable<ConversionJob["artifact"]>;

async function matchesArtifact(path: string, artifact: Artifact): Promise<boolean> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const initial = await file.stat();
    if (!initial.isFile() || initial.size !== artifact.bytes) {
      return false;
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > artifact.bytes) return false;
      hash.update(buffer.subarray(0, bytesRead));
    }

    const [final, pathMetadata] = await Promise.all([file.stat(), lstat(path)]);
    return pathMetadata.isFile() &&
      pathMetadata.dev === final.dev &&
      pathMetadata.ino === final.ino &&
      bytes === artifact.bytes &&
      final.size === artifact.bytes &&
      pathMetadata.size === artifact.bytes &&
      hash.digest("hex") === artifact.sha256;
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => {});
  }
}

function invalidTransition(): JobStoreResult<ConversionJob> {
  return { ok: false, error: { code: "invalid-transition" } };
}

function storageUnavailable(): JobStoreResult<ConversionJob> {
  return { ok: false, error: { code: "storage-unavailable" } };
}

function releaseForRetry(store: JobStore, job: ConversionJob): JobStoreResult<ConversionJob> {
  const released = store.releaseAttachmentClaim(job.id);
  return released.ok ? storageUnavailable() : released;
}

function settleAttachment(
  store: JobStore,
  job: ConversionJob,
  status: "attached" | "failed",
  errorCode: string | null,
): JobStoreResult<ConversionJob> {
  let settled: JobStoreResult<ConversionJob>;
  if (status === "attached") {
    settled = store.markAttached(job.id);
  } else {
    if (errorCode === null) return invalidTransition();
    settled = store.markAttachmentFailed(job.id, errorCode);
  }
  if (settled.ok || settled.error.code !== "invalid-transition") {
    return settled;
  }

  const durable = store.get(job.id);
  if (!durable.ok) return durable;
  if (
    durable.value?.status === "completed" &&
    (status === "attached"
      ? durable.value.attachment?.status === "attached"
      : durable.value.attachment?.status === "failed" &&
        durable.value.attachment.errorCode === errorCode)
  ) {
    return { ok: true, value: durable.value };
  }
  return settled;
}

function failAttachment(
  store: JobStore,
  job: ConversionJob,
  errorCode: string,
): JobStoreResult<ConversionJob> {
  return settleAttachment(store, job, "failed", errorCode);
}

async function reconcileExistingTarget(
  store: JobStore,
  job: ConversionJob,
  targetPath: string,
): Promise<JobStoreResult<ConversionJob>> {
  return await matchesArtifact(targetPath, job.artifact!)
    ? settleAttachment(store, job, "attached", null)
    : failAttachment(store, job, "duplicate-format");
}

export async function reconcileJobAttachment(
  store: JobStore,
  libraryStore: BunSqliteLibraryStore,
  job: ConversionJob,
): Promise<JobStoreResult<ConversionJob>> {
  if (
    job.status !== "completed" ||
    !job.libraryItemId ||
    job.attachment?.status !== "pending" ||
    !job.artifact ||
    job.artifact.path !== job.outputPath
  ) {
    return invalidTransition();
  }

  const current = await libraryStore.get({ id: job.libraryItemId });
  if (!current.ok) {
    return releaseForRetry(store, job);
  }
  if (!current.value) {
    return failAttachment(store, job, "library-item-not-found");
  }

  const existing = current.value.formats.find(({ format }) => format === job.outputFormat);
  if (existing) {
    return reconcileExistingTarget(store, job, existing.sourcePath);
  }

  if (!(await matchesArtifact(job.outputPath, job.artifact))) {
    return failAttachment(store, job, "artifact-invalid");
  }

  const attached = await libraryStore.attachFormat({
    id: job.libraryItemId,
    source: {
      kind: "copy",
      path: job.outputPath,
      expectedArtifact: {
        bytes: job.artifact.bytes,
        sha256: job.artifact.sha256,
      },
    },
  });
  if (!attached.ok) {
    const raced = await libraryStore.get({ id: job.libraryItemId });
    if (!raced.ok) {
      return releaseForRetry(store, job);
    }
    if (!raced.value) {
      return failAttachment(store, job, "library-item-not-found");
    }
    const racedTarget = raced.value.formats.find(({ format }) => format === job.outputFormat);
    return racedTarget
      ? reconcileExistingTarget(store, job, racedTarget.sourcePath)
      : failAttachment(
        store,
        job,
        attached.error.code === "invalid-arguments" ? "artifact-invalid" : attached.error.code,
      );
  }
  if (!attached.value) {
    return failAttachment(store, job, "library-item-not-found");
  }

  const target = attached.value.formats.find(({ format }) => format === job.outputFormat);
  if (
    !target ||
    target.provenance !== "managed" ||
    !(await matchesArtifact(target.sourcePath, job.artifact))
  ) {
    return failAttachment(store, job, "artifact-invalid");
  }

  return settleAttachment(store, job, "attached", null);
}
