import type { LibraryItem } from "@takio/core";

import { describeJobError, type ConversionJob } from "../lib/jobs";

type JobsPanelProps = {
  readonly actionsPending: boolean;
  readonly items: readonly LibraryItem[];
  readonly jobs: readonly ConversionJob[];
  readonly jobsState: "loading" | "ready" | "error";
  readonly conversionRunning: boolean;
  readonly pendingAction: string | null;
  readonly onCancel: (job: ConversionJob) => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly onRetry: (job: ConversionJob) => Promise<void>;
  readonly onRunNext: () => Promise<void>;
};

export function JobsPanel({
  actionsPending,
  items,
  jobs,
  jobsState,
  conversionRunning,
  pendingAction,
  onCancel,
  onRefresh,
  onRetry,
  onRunNext,
}: JobsPanelProps) {
  const queuedJobs = jobs.filter((job) => job.status === "queued");
  const convertingJobId = conversionRunning
    ? (jobs.find((job) => job.status === "running")?.id ?? queuedJobs[0]?.id)
    : undefined;

  return (
    <section
      className="jobs-section"
      aria-labelledby="conversions-heading"
      aria-busy={
        conversionRunning || jobsState === "loading" || pendingAction?.startsWith("job-") === true
      }
    >
      <div className="jobs-heading">
        <div>
          <p className="eyebrow">CONVERSIONS</p>
          <h2 id="conversions-heading">Conversion queue</h2>
        </div>
        <div className="jobs-controls">
          <span className="jobs-summary" aria-live="polite">
            {queuedJobs.length} queued · {jobs.length} total
          </span>
          <button
            className="quiet-button"
            id="jobs-refresh"
            aria-label="Refresh conversion queue"
            disabled={actionsPending || jobsState === "loading"}
            onClick={() => void onRefresh()}
          >
            {jobsState === "loading" ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="quiet-button run-next-button"
            aria-label="Run next queued conversion"
            disabled={
              actionsPending || conversionRunning || jobsState === "loading" || queuedJobs.length === 0
            }
            onClick={() => void onRunNext()}
          >
            {conversionRunning ? "Converting…" : "Run next"}
          </button>
        </div>
      </div>

      {jobsState === "loading" && jobs.length === 0 && (
        <div className="state-panel compact-state">Loading conversions…</div>
      )}

      {jobsState === "error" && jobs.length === 0 && (
        <div className="state-panel compact-state error-panel">
          <strong>Conversions unavailable</strong>
          <span>Takio could not load the conversion list.</span>
        </div>
      )}

      {jobsState === "ready" && jobs.length === 0 && (
        <div className="state-panel compact-state">
          <span>No conversions queued.</span>
        </div>
      )}

      {jobs.length > 0 && (
        <ol className="job-list">
          {jobs.map((job) => {
            const sourceTitle =
              (job.libraryItemId
                ? items.find((item) => item.id === job.libraryItemId)?.title
                : undefined) ??
              items.find((item) =>
                item.formats.some(({ sourcePath }) => sourcePath === job.inputPath),
              )?.title ??
              "Conversion";
            return (
              <li className="job-row" key={job.id}>
                <div className="job-primary">
                  <strong>{sourceTitle}</strong>
                  <span>
                    {job.inputFormat.toUpperCase()} → {job.outputFormat.toUpperCase()}
                  </span>
                </div>
                <div className="job-details">
                  <span className={`job-status status-${job.status}`}>
                    Status:{" "}
                    {job.id === convertingJobId
                      ? "Converting…"
                      : job.status[0].toUpperCase() + job.status.slice(1)}
                  </span>
                  <span className="job-output-label">Output</span>
                  <code title={job.outputPath}>{job.outputPath}</code>
                  {job.status === "failed" && (
                    <span className="job-error">
                      Reason: {describeJobError(job.errorCode ?? "conversion-failed")}
                    </span>
                  )}
                  {job.attachment?.status === "pending" && (
                    <span className="job-status status-queued">Library attachment: Pending</span>
                  )}
                  {job.attachment?.status === "attached" && (
                    <span className="job-status status-completed">
                      Library attachment: Attached
                    </span>
                  )}
                  {job.attachment?.status === "failed" && (
                    <span className="job-error">
                      Library attachment: Failed ({job.attachment.errorCode})
                    </span>
                  )}
                </div>
                {job.status === "queued" && job.id !== convertingJobId && (
                  <button
                    className="row-button danger-button job-cancel"
                    aria-label={`Cancel ${job.inputFormat.toUpperCase()} to ${job.outputFormat.toUpperCase()} conversion for “${sourceTitle}”`}
                    disabled={actionsPending}
                    onClick={() => {
                      void onCancel(job).finally(() => {
                        window.requestAnimationFrame(() =>
                          document.getElementById("jobs-refresh")?.focus(),
                        );
                      });
                    }}
                  >
                    {pendingAction === `job-cancel:${job.id}` ? "Canceling…" : "Cancel"}
                  </button>
                )}
                {(job.status === "failed" || job.status === "canceled") && (
                  <button
                    className="row-button"
                    aria-label={`Retry ${job.inputFormat.toUpperCase()} to ${job.outputFormat.toUpperCase()} conversion for “${sourceTitle}”`}
                    disabled={actionsPending}
                    onClick={() => void onRetry(job)}
                  >
                    {pendingAction === `job-retry:${job.id}` ? "Retrying…" : "Retry"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
