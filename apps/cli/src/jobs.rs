use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::conversion::{Artifact, FormatId, convert, detect_format};
use crate::output::{AppError, AppResult};

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
    type Err = &'static str;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "canceled" => Ok(Self::Canceled),
            _ => Err("invalid-stored-data"),
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
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
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
    pub error_code: Option<String>,
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
                return Err(AppError::new("incompatible-schema"));
            }
            create_schema(&connection)?;
        } else if version != 4 {
            return Err(AppError::new("incompatible-schema"));
        }
        connection.execute("UPDATE jobs SET status='failed',finished_at=?1,error_code='conversion-interrupted',owner_pid=NULL WHERE status='running'",[Utc::now().to_rfc3339()])?;
        Ok(Self { connection })
    }

    pub fn enqueue(
        &self,
        input: &Path,
        output_format: FormatId,
        output: &Path,
        library_item_id: Option<&str>,
    ) -> AppResult<ConversionJob> {
        let input = input
            .canonicalize()
            .map_err(|_| AppError::new("input-unavailable"))?;
        if !input.is_file() || !output.is_absolute() || output.exists() {
            return Err(AppError::new(if output.exists() {
                "output-file-exists"
            } else {
                "invalid-arguments"
            }));
        }
        let input_format =
            detect_format(&input).ok_or_else(|| AppError::new("unsupported-format"))?;
        let id = format!("job_{}", Uuid::new_v4());
        let created = Utc::now().to_rfc3339();
        self.connection.execute("INSERT INTO jobs(id,status,library_item_id,input_path,input_format,output_format,output_path,created_at) VALUES(?1,'queued',?2,?3,?4,?5,?6,?7)",
            params![id,library_item_id,input.to_string_lossy(),input_format.as_str(),output_format.as_str(),output.to_string_lossy(),created])?;
        self.get(&id)?
            .ok_or_else(|| AppError::new("storage-unavailable"))
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

    pub fn cancel(&self, id: &str) -> AppResult<ConversionJob> {
        let changed = self.connection.execute(
            "UPDATE jobs SET status='canceled',finished_at=?2 WHERE id=?1 AND status='queued'",
            params![id, Utc::now().to_rfc3339()],
        )?;
        if changed == 0 {
            return Err(AppError::new(if self.get(id)?.is_some() {
                "invalid-transition"
            } else {
                "unknown-job"
            }));
        }
        self.get(id)?.ok_or_else(|| AppError::new("unknown-job"))
    }

    pub fn retry(&self, id: &str) -> AppResult<ConversionJob> {
        let old = self.get(id)?.ok_or_else(|| AppError::new("unknown-job"))?;
        if !matches!(old.status, JobStatus::Failed | JobStatus::Canceled) {
            return Err(AppError::new("invalid-transition"));
        }
        self.enqueue(
            &old.input_path,
            old.output_format,
            &old.output_path,
            old.library_item_id.as_deref(),
        )
    }

    pub fn retry_attachment(&self, id: &str) -> AppResult<ConversionJob> {
        let job = self.get(id)?.ok_or_else(|| AppError::new("unknown-job"))?;
        if job.status != JobStatus::Completed
            || job.library_item_id.is_none()
            || job.artifact.is_none()
            || job.attachment.as_ref().map(|value| value.status.as_str()) != Some("failed")
        {
            return Err(AppError::new("invalid-transition"));
        }
        self.connection.execute(
            "UPDATE jobs SET attachment_status='pending',attachment_finished_at=NULL,attachment_error_code=NULL,attachment_owner_pid=NULL WHERE id=?1",
            [id],
        )?;
        self.get(id)?.ok_or_else(|| AppError::new("unknown-job"))
    }

    pub fn finish_attachment(
        &self,
        id: &str,
        error_code: Option<&str>,
    ) -> AppResult<ConversionJob> {
        let status = if error_code.is_some() {
            "failed"
        } else {
            "attached"
        };
        let changed = self.connection.execute(
            "UPDATE jobs SET attachment_status=?2,attachment_finished_at=?3,attachment_error_code=?4,attachment_owner_pid=NULL WHERE id=?1 AND attachment_status='pending'",
            params![id, status, Utc::now().to_rfc3339(), error_code],
        )?;
        if changed == 0 {
            return Err(AppError::new(if self.get(id)?.is_some() {
                "invalid-transition"
            } else {
                "unknown-job"
            }));
        }
        self.get(id)?.ok_or_else(|| AppError::new("unknown-job"))
    }

    pub fn run_next(
        &mut self,
        profile: &str,
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
        transaction.execute("UPDATE jobs SET status='running',started_at=?2,owner_pid=?3 WHERE id=?1 AND status='queued'",params![job.id,started,std::process::id()])?;
        transaction.commit()?;
        let result = convert(
            &job.input_path,
            &job.output_path,
            job.output_format,
            profile,
            timeout,
        );
        match result {
            Ok(artifact) => self.complete(&job.id, &artifact)?,
            Err(error) => self.fail(&job.id, error.code())?,
        }
        self.get(&job.id)
    }

    pub fn drain(
        &mut self,
        max_jobs: usize,
        profile: &str,
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

    fn complete(&self, id: &str, artifact: &Artifact) -> AppResult<()> {
        self.connection.execute(
        "UPDATE jobs SET status='completed',finished_at=?2,owner_pid=NULL,artifact_bytes=?3,artifact_sha256=?4,
         attachment_status=CASE WHEN library_item_id IS NULL THEN NULL ELSE 'pending' END WHERE id=?1 AND status='running'",
        params![id,Utc::now().to_rfc3339(),i64::try_from(artifact.bytes).map_err(|_|AppError::new("artifact-invalid"))?,artifact.sha256])?;
        Ok(())
    }
    fn fail(&self, id: &str, code: &str) -> AppResult<()> {
        self.connection.execute("UPDATE jobs SET status='failed',finished_at=?2,owner_pid=NULL,error_code=?3 WHERE id=?1 AND status='running'",params![id,Utc::now().to_rfc3339(),code])?;
        Ok(())
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
fn parse_job(row: JobRow) -> AppResult<ConversionJob> {
    let status = row
        .1
        .parse()
        .map_err(|_| AppError::new("invalid-stored-data"))?;
    let input_format = row
        .4
        .parse()
        .map_err(|_| AppError::new("invalid-stored-data"))?;
    let output_format = row
        .5
        .parse()
        .map_err(|_| AppError::new("invalid-stored-data"))?;
    let artifact = match (row.12, row.13) {
        (Some(bytes), Some(sha256)) => Some(JobArtifact {
            path: PathBuf::from(&row.6),
            bytes: u64::try_from(bytes).map_err(|_| AppError::new("invalid-stored-data"))?,
            sha256,
        }),
        (None, None) => None,
        _ => return Err(AppError::new("invalid-stored-data")),
    };
    let attachment = row.14.map(|status| JobAttachment {
        status,
        finished_at: row.15,
        error_code: row.16,
    });
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
        owner_pid: row.10.map(|value| u32::try_from(value).unwrap_or_default()),
        error_code: row.11,
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
    fn queues_and_cancels() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("book.epub");
        std::fs::write(&input, b"x").unwrap();
        let output = temp.path().join("book.pdf");
        let store = JobStore::open(&temp.path().join("jobs.sqlite")).unwrap();
        let job = store.enqueue(&input, FormatId::Pdf, &output, None).unwrap();
        assert_eq!(job.status, JobStatus::Queued);
        assert_eq!(store.cancel(&job.id).unwrap().status, JobStatus::Canceled);
    }
}
