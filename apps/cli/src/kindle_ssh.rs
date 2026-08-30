use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::output::{AppError, AppResult};

#[derive(Clone, Debug)]
pub struct KindleSshDestination {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub remote_root: String,
    pub identity_file: PathBuf,
    pub timeout: Duration,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindleSshResult {
    pub item_id: String,
    pub transport: &'static str,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub verification: &'static str,
}

pub fn send(
    item_id: &str,
    source: &Path,
    destination: &KindleSshDestination,
) -> AppResult<KindleSshResult> {
    validate_destination(destination)?;
    if item_id.trim().is_empty() {
        return Err(AppError::new("invalid-arguments"));
    }
    let source = source
        .canonicalize()
        .map_err(|_| AppError::new("source-unavailable"))?;
    if !source.is_file() {
        return Err(AppError::new("source-unavailable"));
    }
    let source_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(sanitize_file_name)
        .ok_or_else(|| AppError::new("invalid-arguments"))?;
    let remote_final = format!("{}/{}", destination.remote_root, source_name);
    let remote_partial = format!(
        "{}/.takio-partial-{}",
        destination.remote_root,
        Uuid::new_v4()
    );
    let target = format!("{}@{}", destination.user, destination.host);
    let expected = fingerprint(&source)?;
    let ssh = ssh_base(destination, "ssh");

    let cleanup = || {
        let mut command = command_from(&ssh);
        command.args([&target, "rm", "-f", &remote_partial]);
        let _ = run(&mut command, destination.timeout);
    };
    let outcome = (|| -> AppResult<&'static str> {
        let mut root = command_from(&ssh);
        root.args([&target, "test", "-d", &destination.remote_root]);
        checked(&mut root, destination.timeout, "copy-failed")?;

        let mut absent = command_from(&ssh);
        absent.args([&target, "test", "!", "-e", &remote_final]);
        checked(&mut absent, destination.timeout, "destination-file-exists")?;

        let scp = scp_base(destination);
        let mut copy = command_from(&scp);
        copy.arg(&source).arg(format!("{target}:{remote_partial}"));
        checked(&mut copy, destination.timeout, "copy-failed")?;

        let mut hash = command_from(&ssh);
        hash.args([&target, "sha256sum", &remote_partial]);
        let hash_output = run(&mut hash, destination.timeout)?;
        let verification = if hash_output.status == 0
            && hash_output.stdout.trim_start().starts_with(&expected.1)
        {
            "sha256"
        } else {
            let mut size = command_from(&ssh);
            size.args([&target, "wc", "-c", &remote_partial]);
            let output = checked(&mut size, destination.timeout, "verification-failed")?;
            let actual = output.stdout.split_whitespace().next().unwrap_or_default();
            if actual != expected.0.to_string() {
                return Err(AppError::new("verification-failed"));
            }
            "size"
        };

        let mut publish = command_from(&ssh);
        publish.args([&target, "ln", &remote_partial, &remote_final]);
        checked(&mut publish, destination.timeout, "destination-file-exists")?;
        cleanup();
        Ok(verification)
    })();
    if outcome.is_err() {
        cleanup();
    }
    let verification = outcome?;
    Ok(KindleSshResult {
        item_id: item_id.to_owned(),
        transport: "kindle-ssh",
        path: remote_final,
        bytes: expected.0,
        sha256: expected.1,
        verification,
    })
}

fn validate_destination(destination: &KindleSshDestination) -> AppResult<()> {
    let host = Regex::new(
        r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^\[(?:[0-9A-Fa-f:.]+)\]$",
    )
    .map_err(|_| AppError::new("invalid-arguments"))?;
    let user =
        Regex::new(r"^[A-Za-z0-9._-]{1,64}$").map_err(|_| AppError::new("invalid-arguments"))?;
    let segment =
        Regex::new(r"^[A-Za-z0-9._-]{1,120}$").map_err(|_| AppError::new("invalid-arguments"))?;
    let root = &destination.remote_root;
    let root_segments = root
        .split('/')
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let has_allowed_library = root_segments.iter().any(|value| {
        value.eq_ignore_ascii_case("documents") || value.eq_ignore_ascii_case("koreader")
    });
    if !host.is_match(&destination.host)
        || destination.host.starts_with('-')
        || !user.is_match(&destination.user)
        || destination.user.starts_with('-')
        || destination.port == 0
        || !root.starts_with("/mnt/us/")
        || root.contains("//")
        || !has_allowed_library
        || root_segments
            .into_iter()
            .any(|value| matches!(value, "." | "..") || !segment.is_match(value))
        || !destination.identity_file.is_absolute()
        || !destination.identity_file.is_file()
        || destination
            .identity_file
            .file_name()
            .and_then(|value| value.to_str())
            .is_none_or(|value| value.starts_with('-'))
        || destination.timeout < Duration::from_secs(1)
        || destination.timeout > Duration::from_secs(300)
    {
        return Err(AppError::new("invalid-arguments"));
    }
    Ok(())
}

fn ssh_base(destination: &KindleSshDestination, binary: &str) -> Vec<String> {
    vec![
        binary.to_owned(),
        "-p".to_owned(),
        destination.port.to_string(),
        "-o".to_owned(),
        "StrictHostKeyChecking=yes".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        "PasswordAuthentication=no".to_owned(),
        "-i".to_owned(),
        destination.identity_file.to_string_lossy().into_owned(),
    ]
}

fn scp_base(destination: &KindleSshDestination) -> Vec<String> {
    let mut values = ssh_base(destination, "scp");
    values[1] = "-P".to_owned();
    values
}

fn command_from(arguments: &[String]) -> Command {
    let mut command = Command::new(&arguments[0]);
    command.args(&arguments[1..]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

struct CommandOutput {
    status: i32,
    stdout: String,
}

fn checked(
    command: &mut Command,
    timeout: Duration,
    code: &'static str,
) -> AppResult<CommandOutput> {
    let output = run(command, timeout)?;
    if output.status == 0 {
        Ok(output)
    } else {
        Err(AppError::new(code))
    }
}

fn run(command: &mut Command, timeout: Duration) -> AppResult<CommandOutput> {
    let mut child = command
        .spawn()
        .map_err(|_| AppError::new("backend-unavailable"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| AppError::new("copy-failed"))? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::new("copy-failed"));
        }
        thread::sleep(Duration::from_millis(25));
    };
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_string(&mut stdout)
            .map_err(|_| AppError::new("copy-failed"))?;
    }
    Ok(CommandOutput {
        status: status.code().unwrap_or(1),
        stdout,
    })
}

fn fingerprint(path: &Path) -> AppResult<(u64, String)> {
    let mut file = fs::File::open(path).map_err(|_| AppError::new("source-unavailable"))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    let mut hash = Sha256::new();
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| AppError::new("source-unavailable"))?;
        if read == 0 {
            break;
        }
        bytes += u64::try_from(read).map_err(|_| AppError::new("source-unavailable"))?;
        hash.update(&buffer[..read]);
    }
    Ok((bytes, hex::encode(hash.finalize())))
}

fn sanitize_file_name(value: &str) -> Option<String> {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim_matches(['.', ' ', '_']).to_owned();
    (!sanitized.is_empty() && sanitized.len() <= 120 && !sanitized.starts_with('-'))
        .then_some(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_remote_roots() {
        let destination = KindleSshDestination {
            host: "kindle.local".to_owned(),
            user: "root".to_owned(),
            port: 22,
            remote_root: "/tmp/documents".to_owned(),
            identity_file: PathBuf::from("/missing"),
            timeout: Duration::from_secs(30),
        };
        assert_eq!(
            validate_destination(&destination).unwrap_err().code(),
            "invalid-arguments"
        );
    }

    #[test]
    fn sanitizes_remote_file_names() {
        assert_eq!(
            sanitize_file_name("A book: 1.epub").as_deref(),
            Some("A_book__1.epub")
        );
        assert_eq!(sanitize_file_name("..."), None);
    }
}
