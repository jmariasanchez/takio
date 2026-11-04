use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::conversion::{Artifact, ConversionProfile, convert};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::format::{FormatId, detect_format};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Canceled,
}

impl JobStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

impl std::str::FromStr for JobStatus {
    type Err = AppError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "canceled" => Ok(Self::Canceled),
            _ => Err(crate::app_error!("invalid-stored-data")),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobArtifact {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAttachment {
    pub status: JobAttachmentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<ErrorCode>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobAttachmentStatus {
    Pending,
    Attached,
    Failed,
}

impl JobAttachmentStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Attached => "attached",
            Self::Failed => "failed",
        }
    }
}

impl std::str::FromStr for JobAttachmentStatus {
    type Err = AppError;

    fn from_str(value: &str) -> AppResult<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "attached" => Ok(Self::Attached),
            "failed" => Ok(Self::Failed),
            _ => Err(crate::app_error!("invalid-stored-data")),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionJob {
    pub id: String,
    pub status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_item_id: Option<String>,
    pub input_path: PathBuf,
    pub input_format: FormatId,
    pub output_format: FormatId,
    pub output_path: PathBuf,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<ErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<JobArtifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<JobAttachment>,
}

pub struct JobStore {
    connection: Connection,
}

impl JobStore {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            let existing: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*')",
                [],
                |row| row.get(0),
            )?;
            if existing {
                return Err(crate::app_error!("incompatible-schema"));
            }
            create_schema(&connection)?;
        } else if version != 4 {
            return Err(crate::app_error!("incompatible-schema"));
        }
        let owners = connection
            .prepare("SELECT id,owner_pid FROM jobs WHERE status='running'")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<u32>>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, owner) in owners {
            if owner.is_some_and(owner_may_be_alive) {
                continue;
            }
            connection.execute("UPDATE jobs SET status='failed',finished_at=?1,error_code=?2,owner_pid=NULL WHERE id=?3 AND status='running' AND owner_pid IS ?4",params![Utc::now().to_rfc3339(), ErrorCode::ConversionInterrupted.as_str(), id, owner])?;
        }
        Ok(Self { connection })
    }

    pub fn enqueue(
        &mut self,
        input: &Path,
        output_format: FormatId,
        output: &Path,
        library_item_id: Option<&str>,
    ) -> AppResult<ConversionJob> {
        let input = input
            .canonicalize()
            .map_err(|_| crate::app_error!("input-unavailable"))?;
        if !input.is_file() || !output.is_absolute() || output.exists() {
            return Err(crate::app_error!(if output.exists() {
                crate::error::ErrorCode::OutputFileExists
            } else {
                crate::error::ErrorCode::InvalidArguments
            }));
        }
        let input_format =
            detect_format(&input).ok_or_else(|| crate::app_error!("unsupported-format"))?;
        let id = format!("job_{}", Uuid::new_v4());
        let created = Utc::now().to_rfc3339();
        self.connection.execute("INSERT INTO jobs(id,status,library_item_id,input_path,input_format,output_format,output_path,created_at) VALUES(?1,'queued',?2,?3,?4,?5,?6,?7)",
            params![id,library_item_id,input.to_string_lossy(),input_format.as_str(),output_format.as_str(),output.to_string_lossy(),created])?;
        self.get(&id)?
            .ok_or_else(|| crate::app_error!("storage-unavailable"))
    }

    pub fn list(&self, status: Option<JobStatus>) -> AppResult<Vec<ConversionJob>> {
        let sql = if status.is_some() {
            format!("{SELECT_JOB} WHERE status=?1 ORDER BY enqueue_sequence")
        } else {
            format!("{SELECT_JOB} ORDER BY enqueue_sequence")
        };
        let mut statement = self.connection.prepare(&sql)?;
        let rows = if let Some(status) = status {
            statement
                .query_map([status.as_str()], read_job)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map([], read_job)?
                .collect::<Result<Vec<_>, _>>()?
        };
        rows.into_iter().map(parse_job).collect()
    }

    pub fn get(&self, id: &str) -> AppResult<Option<ConversionJob>> {
        self.connection
            .query_row(&format!("{SELECT_JOB} WHERE id=?1"), [id], read_job)
            .optional()?
            .map(parse_job)
            .transpose()
    }

    pub fn cancel(&mut self, id: &str) -> AppResult<ConversionJob> {
        let changed = self.connection.execute(
            "UPDATE jobs SET status='canceled',finished_at=?2 WHERE id=?1 AND status='queued'",
            params![id, Utc::now().to_rfc3339()],
        )?;
        if changed == 0 {
            return Err(crate::app_error!(if self.get(id)?.is_some() {
                crate::error::ErrorCode::InvalidTransition
            } else {
                crate::error::ErrorCode::UnknownJob
            }));
        }
        self.get(id)?
            .ok_or_else(|| crate::app_error!("unknown-job"))
    }

    pub fn retry(&mut self, id: &str) -> AppResult<ConversionJob> {
        let old = self
            .get(id)?
            .ok_or_else(|| crate::app_error!("unknown-job"))?;
        if !matches!(old.status, JobStatus::Failed | JobStatus::Canceled) {
            return Err(crate::app_error!("invalid-transition"));
        }
        self.enqueue(
            &old.input_path,
            old.output_format,
            &old.output_path,
            old.library_item_id.as_deref(),
        )
    }

    pub fn retry_attachment(&mut self, id: &str) -> AppResult<ConversionJob> {
        let job = self
            .get(id)?
            .ok_or_else(|| crate::app_error!("unknown-job"))?;
        if job.status != JobStatus::Completed
            || job.library_item_id.is_none()
            || job.artifact.is_none()
            || job.attachment.as_ref().map(|value| value.status)
                != Some(JobAttachmentStatus::Failed)
        {
            return Err(crate::app_error!("invalid-transition"));
        }
        self.connection.execute(
            "UPDATE jobs SET attachment_status='pending',attachment_finished_at=NULL,attachment_error_code=NULL,attachment_owner_pid=NULL WHERE id=?1",
            [id],
        )?;
        self.get(id)?
            .ok_or_else(|| crate::app_error!("unknown-job"))
    }

    pub fn finish_attachment(
        &mut self,
        id: &str,
        error_code: Option<ErrorCode>,
    ) -> AppResult<ConversionJob> {
        let status = if error_code.is_some() {
            JobAttachmentStatus::Failed
        } else {
            JobAttachmentStatus::Attached
        };
        let changed = self.connection.execute(
            "UPDATE jobs SET attachment_status=?2,attachment_finished_at=?3,attachment_error_code=?4,attachment_owner_pid=NULL WHERE id=?1 AND attachment_status='pending'",
            params![id, status.as_str(), Utc::now().to_rfc3339(), error_code.map(ErrorCode::as_str)],
        )?;
        if changed == 0 {
            return Err(crate::app_error!(if self.get(id)?.is_some() {
                crate::error::ErrorCode::InvalidTransition
            } else {
                crate::error::ErrorCode::UnknownJob
            }));
        }
        self.get(id)?
            .ok_or_else(|| crate::app_error!("unknown-job"))
    }

    pub fn reconcile_attachment(
        &mut self,
        library: &mut crate::library::store::LibraryStore,
        job: ConversionJob,
    ) -> AppResult<ConversionJob> {
        if job.attachment.as_ref().map(|value| value.status) != Some(JobAttachmentStatus::Pending) {
            return Ok(job);
        }
        let Some(item_id) = job.library_item_id.as_deref() else {
            return self.finish_attachment(&job.id, Some(ErrorCode::InvalidAttachment));
        };
        let Some(artifact) = job.artifact.as_ref() else {
            return self.finish_attachment(&job.id, Some(ErrorCode::ArtifactInvalid));
        };
        let result = library.attach_verified_artifact(
            item_id,
            &artifact.path,
            job.output_format,
            artifact.bytes,
            &artifact.sha256,
        );
        self.finish_attachment(&job.id, result.err().map(|error| error.kind()))
    }

    pub fn run_next(
        &mut self,
        profile: ConversionProfile,
        timeout: Duration,
    ) -> AppResult<Option<ConversionJob>> {
        let transaction = self.connection.transaction()?;
        let row = transaction
            .query_row(
                &format!("{SELECT_JOB} WHERE status='queued' ORDER BY enqueue_sequence LIMIT 1"),
                [],
                read_job,
            )
            .optional()?;
        let Some(row) = row else {
            transaction.commit()?;
            return Ok(None);
        };
        let job = parse_job(row)?;
        let started = Utc::now().to_rfc3339();
        let changed = transaction.execute("UPDATE jobs SET status='running',started_at=?2,owner_pid=?3 WHERE id=?1 AND status='queued'",params![job.id,started,std::process::id()])?;
        transaction.commit()?;
        if changed == 0 {
            return Ok(None);
        }
        let result = convert(
            &job.input_path,
            &job.output_path,
            job.output_format,
            profile,
            timeout,
        );
        match result {
            Ok(artifact) => self.complete(&job.id, &artifact)?,
            Err(error) => self.fail(&job.id, error.kind())?,
        }
        self.get(&job.id)
    }

    pub fn drain(
        &mut self,
        max_jobs: usize,
        profile: ConversionProfile,
        timeout: Duration,
    ) -> AppResult<Vec<ConversionJob>> {
        let mut jobs = Vec::new();
        for _ in 0..max_jobs {
            match self.run_next(profile, timeout)? {
                Some(job) => jobs.push(job),
                None => break,
            }
        }
        Ok(jobs)
    }

    fn complete(&mut self, id: &str, artifact: &Artifact) -> AppResult<()> {
        let changed = self.connection.execute(
        "UPDATE jobs SET status='completed',finished_at=?2,owner_pid=NULL,artifact_bytes=?3,artifact_sha256=?4,
         attachment_status=CASE WHEN library_item_id IS NULL THEN NULL ELSE 'pending' END WHERE id=?1 AND status='running'",
        params![id,Utc::now().to_rfc3339(),i64::try_from(artifact.bytes).map_err(|_|crate::app_error!("artifact-invalid"))?,artifact.sha256])?;
        if changed == 0 {
            return Err(crate::app_error!("invalid-transition"));
        }
        Ok(())
    }
    fn fail(&mut self, id: &str, code: ErrorCode) -> AppResult<()> {
        let changed = self.connection.execute("UPDATE jobs SET status='failed',finished_at=?2,owner_pid=NULL,error_code=?3 WHERE id=?1 AND status='running'",params![id,Utc::now().to_rfc3339(),code.as_str()])?;
        if changed == 0 {
            return Err(crate::app_error!("invalid-transition"));
        }
        Ok(())
    }
}

fn owner_may_be_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Some(pid) = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return true;
        };
        // Permission errors and unknown outcomes must never invalidate live work.
        rustix::process::test_kill_process(pid) != Err(rustix::io::Errno::SRCH)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

const SELECT_JOB: &str = "SELECT id,status,library_item_id,input_path,input_format,output_format,output_path,created_at,started_at,finished_at,owner_pid,error_code,artifact_bytes,artifact_sha256,attachment_status,attachment_finished_at,attachment_error_code FROM jobs";
type JobRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);
fn read_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
        row.get(15)?,
        row.get(16)?,
    ))
}
fn parse_error_code(wire: Option<String>) -> AppResult<Option<ErrorCode>> {
    wire.map(|wire| {
        ErrorCode::from_wire(&wire).ok_or_else(|| crate::app_error!("invalid-stored-data"))
    })
    .transpose()
}

fn parse_job(row: JobRow) -> AppResult<ConversionJob> {
    let status = row
        .1
        .parse()
        .map_err(|_| crate::app_error!("invalid-stored-data"))?;
    let input_format = row
        .4
        .parse()
        .map_err(|_| crate::app_error!("invalid-stored-data"))?;
    let output_format = row
        .5
        .parse()
        .map_err(|_| crate::app_error!("invalid-stored-data"))?;
    let artifact = match (row.12, row.13) {
        (Some(bytes), Some(sha256)) => Some(JobArtifact {
            path: PathBuf::from(&row.6),
            bytes: u64::try_from(bytes).map_err(|_| crate::app_error!("invalid-stored-data"))?,
            sha256,
        }),
        (None, None) => None,
        _ => return Err(crate::app_error!("invalid-stored-data")),
    };
    let attachment_error = parse_error_code(row.16)?;
    let attachment = row
        .14
        .map(|status| -> AppResult<_> {
            Ok(JobAttachment {
                status: status.parse()?,
                finished_at: row.15,
                error_code: attachment_error,
            })
        })
        .transpose()?;
    Ok(ConversionJob {
        id: row.0,
        status,
        library_item_id: row.2,
        input_path: PathBuf::from(row.3),
        input_format,
        output_format,
        output_path: PathBuf::from(row.6),
        created_at: row.7,
        started_at: row.8,
        finished_at: row.9,
        owner_pid: row
            .10
            .map(u32::try_from)
            .transpose()
            .map_err(|_| crate::app_error!("invalid-stored-data"))?,
        error_code: parse_error_code(row.11)?,
        artifact,
        attachment,
    })
}

fn create_schema(connection: &Connection) -> AppResult<()> {
    connection.execute_batch("CREATE TABLE jobs(
 enqueue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','canceled')),
 library_item_id TEXT,input_path TEXT NOT NULL,input_format TEXT NOT NULL,output_format TEXT NOT NULL,output_path TEXT NOT NULL,created_at TEXT NOT NULL,
 started_at TEXT,finished_at TEXT,owner_pid INTEGER,error_code TEXT,artifact_bytes INTEGER,artifact_sha256 TEXT,
 attachment_status TEXT CHECK(attachment_status IN ('pending','attached','failed')),attachment_finished_at TEXT,attachment_error_code TEXT,attachment_owner_pid INTEGER) STRICT;
 CREATE INDEX jobs_status_order ON jobs(status,enqueue_sequence);PRAGMA user_version=4;")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopening_preserves_live_owner_and_recovers_dead_owner() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("book.epub");
        std::fs::write(&input, b"book").unwrap();
        let database = temp.path().join("jobs.sqlite");
        let mut store = JobStore::open(&database).unwrap();
        let job = store
            .enqueue(&input, FormatId::Pdf, &temp.path().join("book.pdf"), None)
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE jobs SET status='running',owner_pid=?1",
                [std::process::id()],
            )
            .unwrap();
        let reader = JobStore::open(&database).unwrap();
        assert_eq!(
            reader.get(&job.id).unwrap().unwrap().status,
            JobStatus::Running
        );
        drop(reader);
        #[cfg(unix)]
        {
            let mut live = std::process::Command::new("/bin/sleep")
                .arg("30")
                .spawn()
                .unwrap();
            store
                .connection
                .execute("UPDATE jobs SET owner_pid=?1", [live.id()])
                .unwrap();
            let status = JobStore::open(&database)
                .unwrap()
                .get(&job.id)
                .unwrap()
                .unwrap()
                .status;
            live.kill().unwrap();
            live.wait().unwrap();
            assert_eq!(status, JobStatus::Running);
            let mut child = std::process::Command::new("/bin/sh")
                .args(["-c", "exit 0"])
                .spawn()
                .unwrap();
            let dead_pid = child.id();
            child.wait().unwrap();
            store
                .connection
                .execute("UPDATE jobs SET owner_pid=?1", [dead_pid])
                .unwrap();
            let reader = JobStore::open(&database).unwrap();
            assert_eq!(
                reader.get(&job.id).unwrap().unwrap().error_code,
                Some(ErrorCode::ConversionInterrupted)
            );
        }
    }

    #[test]
    fn completion_and_failure_reject_lost_claims() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("book.epub");
        std::fs::write(&input, b"book").unwrap();
        let mut store = JobStore::open(&temp.path().join("jobs.sqlite")).unwrap();
        let job = store
            .enqueue(&input, FormatId::Pdf, &temp.path().join("book.pdf"), None)
            .unwrap();
        let artifact = Artifact {
            path: job.output_path.clone(),
            bytes: 4,
            sha256: "hash".into(),
            created_at: Utc::now().to_rfc3339(),
        };
        assert_eq!(
            store.complete(&job.id, &artifact).unwrap_err().kind(),
            ErrorCode::InvalidTransition
        );
        assert_eq!(
            store
                .fail(&job.id, ErrorCode::ConversionInterrupted)
                .unwrap_err()
                .kind(),
            ErrorCode::InvalidTransition
        );
        assert_eq!(
            store.get(&job.id).unwrap().unwrap().status,
            JobStatus::Queued
        );
    }

    #[test]
    fn lost_claim_does_not_run_conversion() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("book.epub");
        std::fs::write(&input, b"book").unwrap();
        let mut store = JobStore::open(&temp.path().join("jobs.sqlite")).unwrap();
        let job = store
            .enqueue(&input, FormatId::Pdf, &temp.path().join("book.pdf"), None)
            .unwrap();
        store.connection.execute_batch("CREATE TRIGGER suppress_claim BEFORE UPDATE OF status ON jobs WHEN NEW.status='running' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
        assert!(
            store
                .run_next(ConversionProfile::default(), Duration::from_secs(1))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store.get(&job.id).unwrap().unwrap().status,
            JobStatus::Queued
        );
        assert!(!job.output_path.exists());
    }

    #[test]
    fn persisted_error_codes_round_trip_and_unknown_codes_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("book.epub");
        std::fs::write(&input, b"book").unwrap();
        let database = temp.path().join("jobs.sqlite");
        let mut store = JobStore::open(&database).unwrap();
        let job = store
            .enqueue(
                &input,
                FormatId::Pdf,
                &temp.path().join("book.pdf"),
                Some("book-1"),
            )
            .unwrap();
        for &code in ErrorCode::ALL {
            store
                .connection
                .execute(
                    "UPDATE jobs SET status='running',attachment_status='pending'",
                    [],
                )
                .unwrap();
            store.fail(&job.id, code).unwrap();
            let job = store.finish_attachment(&job.id, Some(code)).unwrap();
            assert_eq!(job.error_code, Some(code));
            assert_eq!(job.attachment.as_ref().unwrap().error_code, Some(code));
            let wire = serde_json::to_value(job).unwrap();
            assert_eq!(wire["errorCode"], code.as_str());
            assert_eq!(wire["attachment"]["errorCode"], code.as_str());
            assert_eq!(wire["attachment"]["status"], "failed");
        }
        for column in ["error_code", "attachment_error_code"] {
            store
                .connection
                .execute(
                    "UPDATE jobs SET error_code=NULL,attachment_error_code=NULL",
                    [],
                )
                .unwrap();
            store
                .connection
                .execute(&format!("UPDATE jobs SET {column}='unknown-code'"), [])
                .unwrap();
            assert_eq!(
                store.get(&job.id).unwrap_err().kind(),
                ErrorCode::InvalidStoredData
            );
            assert_eq!(
                store.list(None).unwrap_err().kind(),
                ErrorCode::InvalidStoredData
            );
        }
        store
            .connection
            .execute(
                "UPDATE jobs SET status='running',error_code=NULL,attachment_error_code=NULL",
                [],
            )
            .unwrap();
        drop(store);
        let reopened = JobStore::open(&database).unwrap();
        let recovered = reopened.get(&job.id).unwrap().unwrap();
        assert_eq!(recovered.error_code, Some(ErrorCode::ConversionInterrupted));
        assert_eq!(
            serde_json::to_value(recovered).unwrap()["errorCode"],
            "conversion-interrupted"
        );
    }
    #[test]
    fn corrupt_attachment_status_and_owner_pid_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("book.epub");
        std::fs::write(&input, b"book").unwrap();
        let mut store = JobStore::open(&temp.path().join("jobs.sqlite")).unwrap();
        let job = store
            .enqueue(&input, FormatId::Pdf, &temp.path().join("book.pdf"), None)
            .unwrap();
        for pid in [-1_i64, i64::from(u32::MAX) + 1] {
            store
                .connection
                .execute("UPDATE jobs SET owner_pid=?1", [pid])
                .unwrap();
            assert_eq!(
                store.get(&job.id).unwrap_err().code(),
                "invalid-stored-data"
            );
        }
        store
            .connection
            .execute("UPDATE jobs SET owner_pid=NULL", [])
            .unwrap();
        for status in ["pending", "attached", "failed"] {
            store
                .connection
                .execute("UPDATE jobs SET attachment_status=?1", [status])
                .unwrap();
            let attachment = store.get(&job.id).unwrap().unwrap().attachment.unwrap();
            assert_eq!(attachment.status.as_str(), status);
            assert_eq!(serde_json::to_value(attachment).unwrap()["status"], status);
        }
        store
            .connection
            .pragma_update(None, "ignore_check_constraints", true)
            .unwrap();
        store
            .connection
            .execute("UPDATE jobs SET attachment_status='bogus'", [])
            .unwrap();
        assert_eq!(
            store.get(&job.id).unwrap_err().code(),
            "invalid-stored-data"
        );
    }
    #[test]
    fn queues_and_cancels() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("book.epub");
        std::fs::write(&input, b"x").unwrap();
        let output = temp.path().join("book.pdf");
        let mut store = JobStore::open(&temp.path().join("jobs.sqlite")).unwrap();
        let job = store.enqueue(&input, FormatId::Pdf, &output, None).unwrap();
        assert_eq!(job.status, JobStatus::Queued);
        assert_eq!(store.cancel(&job.id).unwrap().status, JobStatus::Canceled);
    }
}
