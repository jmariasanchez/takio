use super::*;

#[derive(Subcommand)]
pub(super) enum JobsCommand {
    #[command(about = "Queue a conversion job")]
    Enqueue {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        input: Option<PathBuf>,
        #[arg(long = "from")]
        from: Option<FormatId>,
        #[arg(long = "to")]
        to: FormatId,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        library_item_id: Option<String>,
    },
    #[command(about = "List jobs, optionally filtered by status")]
    List {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        status: Option<JobStatus>,
    },
    #[command(about = "Get one job")]
    Get {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    #[command(about = "Cancel a queued job")]
    Cancel {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    #[command(about = "Requeue a failed or canceled job")]
    Retry {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
    #[command(about = "Claim and run the oldest queued job in the foreground")]
    RunNext {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value = "default")]
        profile: String,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    #[command(about = "Run queued jobs in the foreground up to a bounded count")]
    Drain {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long, default_value_t = MAX_BATCH)]
        max_jobs: usize,
        #[arg(long, default_value = "default")]
        profile: String,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    #[command(about = "Retry attaching a completed job's output to its library item")]
    RetryAttachment {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        id: String,
    },
}

pub(super) fn jobs(command: JobsCommand, library: Option<&str>) -> AppResult<()> {
    match command {
        JobsCommand::Enqueue {
            db,
            input,
            from,
            to,
            output,
            library_item_id,
        } => {
            let input = match (input, library_item_id.as_deref(), from) {
                (Some(input), None, None) => input,
                (None, Some(item_id), Some(format)) => {
                    let store = read_store(library, None)?;
                    let item = store
                        .get(item_id)?
                        .ok_or_else(|| takio::app_error!("not-found"))?;
                    item.formats
                        .into_iter()
                        .find(|candidate| candidate.format == format)
                        .map(|candidate| candidate.source_path)
                        .ok_or_else(|| takio::app_error!("format-not-found"))?
                }
                _ => return Err(takio::app_error!("invalid-arguments")),
            };
            let path = job_path(library, db.as_deref())?;
            let output = absolute(&output)?;
            let job =
                JobStore::open(&path)?.enqueue(&input, to, &output, library_item_id.as_deref())?;
            print_success(json!({ "job": job }))
        }
        JobsCommand::List { db, status } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"jobs":JobStore::open(&path)?.list(status)?}))
        }
        JobsCommand::Get { db, id } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"job":JobStore::open(&path)?.get(&id)?}))
        }
        JobsCommand::Cancel { db, id } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"job":JobStore::open(&path)?.cancel(&id)?}))
        }
        JobsCommand::Retry { db, id } => {
            let path = job_path(library, db.as_deref())?;
            print_success(json!({"job":JobStore::open(&path)?.retry(&id)?}))
        }
        JobsCommand::RunNext {
            db,
            profile,
            timeout_seconds,
        } => {
            let path = job_path(library, db.as_deref())?;
            let mut store = JobStore::open(&path)?;
            let job = store.run_next(profile.parse()?, Duration::from_secs(timeout_seconds))?;
            let job = job
                .map(|job| reconcile_job_attachment(&mut store, library, job))
                .transpose()?;
            print_success(json!({"job":job}))
        }
        JobsCommand::Drain {
            db,
            max_jobs,
            profile,
            timeout_seconds,
        } => {
            let path = job_path(library, db.as_deref())?;
            let mut store = JobStore::open(&path)?;
            let values = store.drain(
                max_jobs,
                profile.parse()?,
                Duration::from_secs(timeout_seconds),
            )?;
            let values = values
                .into_iter()
                .map(|job| reconcile_job_attachment(&mut store, library, job))
                .collect::<AppResult<Vec<_>>>()?;
            print_success(json!({"jobs":values,"counts":{"processed":values.len()}}))
        }
        JobsCommand::RetryAttachment { db, id } => {
            if db.is_some() || id.trim().is_empty() {
                return Err(takio::app_error!("invalid-arguments"));
            }
            let path = job_path(library, None)?;
            let mut store = JobStore::open(&path)?;
            let job = store.retry_attachment(&id)?;
            print_success(json!({"job":reconcile_job_attachment(&mut store, library, job)?}))
        }
    }
}

fn reconcile_job_attachment(
    jobs: &mut JobStore,
    library: Option<&str>,
    job: takio::conversion::jobs::ConversionJob,
) -> AppResult<takio::conversion::jobs::ConversionJob> {
    if job.attachment.as_ref().map(|value| value.status) != Some(JobAttachmentStatus::Pending) {
        return Ok(job);
    }
    let paths = LibraryPaths::resolve(library, None)?;
    match LibraryStore::create_or_migrate(paths) {
        Ok(mut store) => jobs.reconcile_attachment(&mut store, job),
        Err(error) => jobs.finish_attachment(&job.id, Some(error.kind())),
    }
}

pub(super) fn job_path(library: Option<&str>, db: Option<&Path>) -> AppResult<PathBuf> {
    if db.is_some() && library.is_some() {
        return Err(takio::app_error!("invalid-arguments"));
    }
    Ok(db
        .map(Path::to_path_buf)
        .unwrap_or(LibraryPaths::resolve(library, None)?.jobs))
}
