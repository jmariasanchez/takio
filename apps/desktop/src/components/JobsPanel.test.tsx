import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConversionJob } from "../lib/jobs";
import { JobsPanel } from "./JobsPanel";

const queuedJobs: readonly ConversionJob[] = [
  {
    id: "job_1",
    status: "queued",
    inputPath: "/Books/First.epub",
    inputFormat: "epub",
    outputFormat: "pdf",
    outputPath: "/Exports/First.pdf",
    createdAt: "2026-07-19T12:00:00.000Z",
  },
  {
    id: "job_2",
    status: "queued",
    inputPath: "/Books/Second.epub",
    inputFormat: "epub",
    outputFormat: "pdf",
    outputPath: "/Exports/Second.pdf",
    createdAt: "2026-07-19T12:01:00.000Z",
  },
];

function renderJobs(
  jobs: readonly ConversionJob[],
  overrides: { readonly conversionRunning?: boolean; readonly pendingAction?: string | null } = {},
): string {
  return renderToStaticMarkup(
    <JobsPanel
      actionsPending={overrides.pendingAction !== null && overrides.pendingAction !== undefined}
      items={[]}
      jobs={jobs}
      jobsState="ready"
      conversionRunning={overrides.conversionRunning ?? false}
      pendingAction={overrides.pendingAction ?? null}
      onCancel={async () => undefined}
      onRefresh={async () => undefined}
      onRetry={async () => undefined}
      onRunNext={async () => undefined}
    />,
  );
}

test("shows the active conversion truthfully while preserving later queued cancellation", () => {
  const runningJob: ConversionJob = {
    ...queuedJobs[0],
    status: "running",
    startedAt: "2026-07-19T12:02:00.000Z",
  };
  const markup = renderJobs([runningJob, queuedJobs[1]], { conversionRunning: true });

  expect(markup).toContain("Status: Converting…");
  expect(markup).toContain("Status: Queued");
  expect(markup).not.toContain("Status: Running");
  expect(markup).toContain(">Converting…</button>");
  expect(markup.match(/Cancel EPUB to PDF conversion for “Conversion”/g)).toHaveLength(1);
  expect(markup.match(/>Cancel<\/button>/g)).toHaveLength(1);
});

test("offers retry for an interrupted conversion and explains the interruption", () => {
  const interrupted: ConversionJob = {
    ...queuedJobs[0],
    status: "failed",
    startedAt: "2026-07-19T12:02:00.000Z",
    finishedAt: "2026-07-19T12:03:00.000Z",
    errorCode: "interrupted",
  };
  const markup = renderJobs([interrupted]);

  expect(markup).toContain(
    "Takio stopped while this conversion was running. Retry to start it again.",
  );
  expect(markup).toContain("Retry EPUB to PDF conversion for “Conversion”");
  expect(markup).toContain(">Retry</button>");
});

test("offers retry for a canceled conversion", () => {
  const canceled: ConversionJob = {
    ...queuedJobs[0],
    status: "canceled",
    finishedAt: "2026-07-19T12:03:00.000Z",
  };

  expect(renderJobs([canceled])).toContain(">Retry</button>");
});
