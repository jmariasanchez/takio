import { expect, test } from "bun:test";

import {
  cancelConversionJob,
  describeJobError,
  describeUnexpectedJobError,
  enqueueConversionJob,
  listConversionJobs,
  runNextConversionJob,
  type JobInvoker,
} from "./jobs";

const queuedJob = {
  id: "job_1",
  status: "queued",
  inputPath: "/Books/A title.epub",
  inputFormat: "epub",
  outputFormat: "pdf",
  outputPath: "/Exports/A title.pdf",
  createdAt: "2026-07-19T12:00:00.000Z",
} as const;

const completedJob = {
  ...queuedJob,
  status: "completed",
  startedAt: "2026-07-19T12:01:00.000Z",
  finishedAt: "2026-07-19T12:02:00.000Z",
  artifact: {
    path: queuedJob.outputPath,
    bytes: 512,
    sha256: "a".repeat(64),
  },
} as const;

test("uses only the fixed desktop job commands and argument names", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: JobInvoker = async (command, args) => {
    calls.push({ command, args });
    if (command === "jobs_list") {
      return { ok: true, value: { jobs: [queuedJob] } } as never;
    }
    if (command === "jobs_run_next") {
      return { ok: true, value: { job: completedJob } } as never;
    }
    return { ok: true, value: { job: queuedJob } } as never;
  };

  await listConversionJobs(invokeCommand);
  await enqueueConversionJob(
    {
      inputPath: queuedJob.inputPath,
      outputFormat: "mobi",
      outputPath: "/Exports/A title.mobi",
    },
    invokeCommand,
  );
  await enqueueConversionJob(
    {
      libraryItemId: "book-1",
      inputFormat: queuedJob.inputFormat,
      outputFormat: queuedJob.outputFormat,
      outputPath: queuedJob.outputPath,
    },
    invokeCommand,
  );
  await runNextConversionJob(invokeCommand);
  await cancelConversionJob(queuedJob.id, invokeCommand);

  expect(calls).toEqual([
    { command: "jobs_list", args: undefined },
    {
      command: "jobs_enqueue",
      args: { input: "/Books/A title.epub", to: "mobi", output: "/Exports/A title.mobi" },
    },
    {
      command: "jobs_enqueue",
      args: {
        libraryItemId: "book-1",
        from: "epub",
        to: "pdf",
        output: "/Exports/A title.pdf",
      },
    },
    { command: "jobs_run_next", args: undefined },
    { command: "jobs_cancel", args: { id: "job_1" } },
  ]);
});

test("accepts an empty run-next result", async () => {
  const result = await runNextConversionJob(async () => ({
    ok: true,
    value: { job: null },
  }) as never);

  expect(result).toEqual({ ok: true, value: { job: null } });
});

test("rejects malformed successful job records at the bridge boundary", async () => {
  const invalidList = await listConversionJobs(async () => ({
    ok: true,
    value: { jobs: [{ ...queuedJob, status: "completed" }] },
  }) as never);
  const invalidMutation = await cancelConversionJob("job_1", async () => ({
    ok: true,
    value: { job: { ...completedJob, artifact: { ...completedJob.artifact, bytes: 0 } } },
  }) as never);

  expect(invalidList).toEqual({ ok: false, error: { code: "protocol-error" } });
  expect(invalidMutation).toEqual({ ok: false, error: { code: "protocol-error" } });
});

test("preserves declared failures and sanitizes unexpected details", async () => {
  const failure = await listConversionJobs(async () => ({
    ok: false,
    error: { code: "storage-unavailable" },
  }) as never);
  const implementationDetail = "invoke exploded at /private/user/path";

  expect(failure).toEqual({ ok: false, error: { code: "storage-unavailable" } });
  expect(describeJobError("backend-unavailable")).toBe(
    "The Calibre conversion engine is unavailable.",
  );
  expect(describeUnexpectedJobError(new Error(implementationDetail))).toBe(
    "The conversion service is unavailable.",
  );
  expect(describeUnexpectedJobError(new Error(implementationDetail))).not.toContain(
    implementationDetail,
  );
});
