import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LibraryItem } from "@takio/core";
import { BunSqliteLibraryStore } from "@takio/library-store-bun";

import { reconcileJobAttachment } from "../src/job-attachment.js";
import { JobStore, type ConversionJob } from "../src/job-store.js";

const addedAt = "2026-07-20T12:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("linked job attachment reconciliation", () => {
  let root: string;
  let jobs: JobStore;
  let library: BunSqliteLibraryStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "takio-job-attachment-")));
    jobs = new JobStore(join(root, "jobs.sqlite"));
    library = new BunSqliteLibraryStore(join(root, "library.sqlite"));
    expect(jobs.open()).toEqual({ ok: true, value: null });
    expect(await library.open({ config: {} })).toEqual({ ok: true, value: null });
  });

  afterEach(async () => {
    jobs.close();
    library.close();
    await rm(root, { recursive: true, force: true });
  });

  async function addPrimaryMobi(id: string = "book-1"): Promise<LibraryItem> {
    const sourcePath = join(root, `${id}.mobi`);
    await writeFile(sourcePath, "primary mobi");
    const canonicalPath = await realpath(sourcePath);
    const item: LibraryItem = {
      id,
      title: "A book",
      sourcePath: canonicalPath,
      format: "mobi",
      addedAt,
      formats: [{
        sourcePath: canonicalPath,
        format: "mobi",
        addedAt,
        provenance: "referenced",
      }],
      tags: [],
    };
    expect(await library.add({ item })).toEqual({ ok: true, value: item });
    return item;
  }

  async function completedLinkedJob(
    contents: string,
    libraryItemId: string = "book-1",
  ): Promise<ConversionJob> {
    const inputPath = join(root, `${libraryItemId}.epub`);
    const outputPath = join(root, `${libraryItemId}.pdf`);
    await writeFile(inputPath, "source epub");
    const queued = jobs.enqueue({
      libraryItemId,
      inputPath,
      inputFormat: "epub",
      outputFormat: "pdf",
      outputPath,
    });
    if (!queued.ok) throw new Error(`enqueue failed: ${queued.error.code}`);
    expect(jobs.claimNext(101)).toMatchObject({ ok: true, value: { id: queued.value.id } });
    await writeFile(outputPath, contents);
    const completed = await jobs.complete(queued.value.id, {
      path: outputPath,
      bytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
    });
    if (!completed.ok) throw new Error(`completion failed: ${completed.error.code}`);
    expect(completed.value.attachment).toEqual({ status: "pending" });
    const claimed = jobs.claimNextPendingAttachment();
    if (!claimed.ok || !claimed.value) throw new Error("attachment claim failed");
    expect(claimed.value.id).toBe(completed.value.id);
    return claimed.value;
  }

  it("attaches a verified managed copy without changing the primary aliases", async () => {
    const primary = await addPrimaryMobi();
    const job = await completedLinkedJob("converted pdf");
    const attachFormat = library.attachFormat.bind(library);
    let expectedArtifact: { bytes: number; sha256: string } | undefined;
    library.attachFormat = async (request) => {
      expectedArtifact = request.source.kind === "copy" ? request.source.expectedArtifact : undefined;
      return attachFormat(request);
    };

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "attached" } },
    });
    expect(expectedArtifact).toEqual({ bytes: job.artifact!.bytes, sha256: job.artifact!.sha256 });
    const stored = await library.get({ id: primary.id });
    if (!stored.ok || !stored.value) throw new Error("attached item missing");
    expect(stored.value.sourcePath).toBe(primary.sourcePath);
    expect(stored.value.format).toBe(primary.format);
    expect(stored.value.formats[0]).toEqual(primary.formats[0]);
    expect(stored.value.formats).toHaveLength(2);
    expect(stored.value.formats[1]).toMatchObject({ format: "pdf", provenance: "managed" });
    expect(stored.value.formats[1]!.sourcePath).not.toBe(job.outputPath);
    expect(await readFile(stored.value.formats[1]!.sourcePath, "utf8")).toBe("converted pdf");
    expect(await readFile(job.outputPath, "utf8")).toBe("converted pdf");
  });

  it("converges after a lost receipt when the existing target has the exact artifact hash", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("converted pdf");
    expect(await library.attachFormat({
      id: job.libraryItemId!,
      source: { kind: "copy", path: job.outputPath },
    })).toMatchObject({ ok: true, value: { formats: [{ format: "mobi" }, { format: "pdf" }] } });

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "attached" } },
    });
    const stored = await library.get({ id: job.libraryItemId! });
    expect(stored).toMatchObject({ ok: true, value: { formats: [{ format: "mobi" }, { format: "pdf" }] } });
  });

  it("converges from an exact managed target after the caller output is deleted", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("converted pdf");
    expect(await library.attachFormat({
      id: job.libraryItemId!,
      source: { kind: "copy", path: job.outputPath },
    })).toMatchObject({ ok: true, value: { formats: [{ format: "mobi" }, { format: "pdf" }] } });
    await unlink(job.outputPath);

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "attached" } },
    });
  });

  it("accepts an exact referenced target as a durable lost receipt", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("converted pdf");
    expect(await library.attachFormat({
      id: job.libraryItemId!,
      source: { kind: "reference", path: job.outputPath },
    })).toMatchObject({
      ok: true,
      value: { formats: [{ format: "mobi" }, { format: "pdf", provenance: "referenced" }] },
    });

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "attached" } },
    });
  });

  it("fails without replacing a same-size existing target whose hash differs", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("expected pdf");
    const otherPdf = join(root, "other.pdf");
    await writeFile(otherPdf, "rejected pdf");
    expect(Buffer.byteLength("rejected pdf")).toBe(job.artifact!.bytes);
    const existing = await library.attachFormat({
      id: job.libraryItemId!,
      source: { kind: "copy", path: otherPdf },
    });
    if (!existing.ok || !existing.value) throw new Error("conflicting format was not attached");
    const existingPath = existing.value.formats[1]!.sourcePath;

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: job.id,
        attachment: { status: "failed", errorCode: "duplicate-format" },
      },
    });
    expect(await readFile(existingPath, "utf8")).toBe("rejected pdf");
    expect(await readFile(job.outputPath, "utf8")).toBe("expected pdf");
  });

  it("rejects a caller output changed after conversion completion", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("verified pdf");
    await writeFile(job.outputPath, "changed pdf");

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: job.id,
        attachment: { status: "failed", errorCode: "artifact-invalid" },
      },
    });
    expect(await library.get({ id: job.libraryItemId! })).toMatchObject({
      ok: true,
      value: { formats: [{ format: "mobi" }] },
    });
    expect(await readFile(job.outputPath, "utf8")).toBe("changed pdf");
  });

  it("does not follow a caller output symlink even when its target hash matches", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("verified pdf");
    const symlinkTarget = join(root, "symlink-target.pdf");
    await writeFile(symlinkTarget, "verified pdf");
    await unlink(job.outputPath);
    await symlink(symlinkTarget, job.outputPath);

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: job.id,
        attachment: { status: "failed", errorCode: "artifact-invalid" },
      },
    });
    expect(await library.get({ id: job.libraryItemId! })).toMatchObject({
      ok: true,
      value: { formats: [{ format: "mobi" }] },
    });
  });

  it("maps a source lost during attachment to artifact-invalid", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("verified pdf");
    library.attachFormat = async () => {
      await unlink(job.outputPath);
      return { ok: false, error: { code: "invalid-arguments" } };
    };

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: job.id,
        attachment: { status: "failed", errorCode: "artifact-invalid" },
      },
    });
  });

  it("reconciles an exact target after a duplicate race", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("converted pdf");
    const attachFormat = library.attachFormat.bind(library);
    library.attachFormat = async (request) => {
      expect(await attachFormat(request)).toMatchObject({ ok: true });
      return { ok: false, error: { code: "duplicate-format" } };
    };

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "attached" } },
    });
  });

  it("reconciles durable library truth after an ambiguous post-commit error", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("converted pdf");
    const attachFormat = library.attachFormat.bind(library);
    library.attachFormat = async (request) => {
      expect(await attachFormat(request)).toMatchObject({ ok: true });
      return { ok: false, error: { code: "storage-unavailable" } };
    };

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "attached" } },
    });
  });

  it("leaves the receipt pending when library truth is unreadable after an attach error", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("converted pdf");
    const get = library.get.bind(library);
    let reads = 0;
    library.get = async (request) => {
      reads += 1;
      return reads === 1 ? get(request) : { ok: false, error: { code: "storage-unavailable" } };
    };
    library.attachFormat = async () => ({
      ok: false,
      error: { code: "storage-unavailable" },
    });

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toEqual({ ok: false, error: { code: "storage-unavailable" } });
    expect(jobs.get(job.id)).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "pending" } },
    });
    expect(jobs.claimNextPendingAttachment(202)).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "pending" } },
    });
  });

  it("releases the receipt for retry when the initial library read is unavailable", async () => {
    const job = await completedLinkedJob("converted pdf");
    library.get = async () => ({ ok: false, error: { code: "storage-unavailable" } });

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toEqual({ ok: false, error: { code: "storage-unavailable" } });
    expect(jobs.claimNextPendingAttachment(203)).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "pending" } },
    });
  });

  it("treats an already-durable matching receipt as idempotent", async () => {
    await addPrimaryMobi();
    const job = await completedLinkedJob("converted pdf");
    const markAttached = jobs.markAttached.bind(jobs);
    jobs.markAttached = (id) => {
      expect(markAttached(id)).toMatchObject({
        ok: true,
        value: { attachment: { status: "attached" } },
      });
      return { ok: false, error: { code: "invalid-transition" } };
    };

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: { id: job.id, attachment: { status: "attached" } },
    });
  });

  it("records a missing linked item without deleting the caller output", async () => {
    const job = await completedLinkedJob("converted pdf", "missing-book");

    const result = await reconcileJobAttachment(jobs, library, job);

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: job.id,
        attachment: { status: "failed", errorCode: "library-item-not-found" },
      },
    });
    expect(await readFile(job.outputPath, "utf8")).toBe("converted pdf");
  });
});
