use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use uuid::Uuid;

use crate::error::AppResult;

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
    destination: &KindleSshDestination,
    item_id: &str,
    source: &Path,
) -> AppResult<KindleSshResult> {
    send_with_programs(item_id, source, destination, "ssh", "scp")
}

fn send_with_programs(
    item_id: &str,
    source: &Path,
    destination: &KindleSshDestination,
    ssh_program: &str,
    scp_program: &str,
) -> AppResult<KindleSshResult> {
    validate_destination(destination)?;
    if item_id.trim().is_empty() {
        return Err(crate::app_error!("invalid-arguments"));
    }
    let source = source
        .canonicalize()
        .map_err(|_| crate::app_error!("source-unavailable"))?;
    if !source.is_file() {
        return Err(crate::app_error!("source-unavailable"));
    }
    let source_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(sanitize_file_name)
        .ok_or_else(|| crate::app_error!("invalid-arguments"))?;
    let remote_final = format!("{}/{}", destination.remote_root, source_name);
    let remote_partial = format!(
        "{}/.takio-partial-{}",
        destination.remote_root,
        Uuid::new_v4()
    );
    let target = format!("{}@{}", destination.user, destination.host);
    let expected = fingerprint(&source)?;
    let ssh = ssh_base(destination, ssh_program);

    let cleanup = || {
        let mut command = command_from(&ssh);
        command.args([&target, "rm", "-f", &remote_partial]);
        let _ = run(&mut command, destination.timeout);
    };
    let outcome = (|| -> AppResult<&'static str> {
        let mut root = command_from(&ssh);
        root.args([&target, "test", "-d", &destination.remote_root]);
        checked(
            &mut root,
            destination.timeout,
            crate::error::ErrorCode::CopyFailed,
        )?;

        let mut absent = command_from(&ssh);
        absent.args([&target, "test", "!", "-e", &remote_final]);
        let output = run(&mut absent, destination.timeout)?;
        match output.status {
            0 => {}
            1 => return Err(crate::app_error!("destination-file-exists")),
            _ => return Err(crate::app_error!("copy-failed")),
        }

        let scp = scp_base(destination, scp_program);
        let mut copy = command_from(&scp);
        copy.arg(&source).arg(format!("{target}:{remote_partial}"));
        checked(
            &mut copy,
            destination.timeout,
            crate::error::ErrorCode::CopyFailed,
        )?;

        let mut hash = command_from(&ssh);
        hash.args([&target, "sha256sum", &remote_partial]);
        let hash_output = run(&mut hash, destination.timeout)?;
        let verification = if hash_output.status == 0 {
            if hash_output.stdout.split_whitespace().next() != Some(expected.sha256.as_str()) {
                return Err(crate::app_error!("verification-failed"));
            }
            "sha256"
        } else {
            if hash_output.status == 255 {
                return Err(crate::app_error!("copy-failed"));
            }
            let mut size = command_from(&ssh);
            size.args([&target, "wc", "-c", &remote_partial]);
            let output = checked(
                &mut size,
                destination.timeout,
                crate::error::ErrorCode::VerificationFailed,
            )?;
            let actual = output.stdout.split_whitespace().next().unwrap_or_default();
            if actual != expected.bytes.to_string() {
                return Err(crate::app_error!("verification-failed"));
            }
            "size"
        };

        let mut publish = command_from(&ssh);
        publish.args([&target, "ln", &remote_partial, &remote_final]);
        let output = run(&mut publish, destination.timeout)?;
        if output.status != 0 {
            if output.status == 255 {
                return Err(crate::app_error!("copy-failed"));
            }
            let mut exists = command_from(&ssh);
            exists.args([&target, "test", "-e", &remote_final]);
            let output = run(&mut exists, destination.timeout)?;
            return Err(crate::app_error!(if output.status == 0 {
                crate::error::ErrorCode::DestinationFileExists
            } else {
                crate::error::ErrorCode::CopyFailed
            }));
        }
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
        bytes: expected.bytes,
        sha256: expected.sha256,
        verification,
    })
}

fn validate_destination(destination: &KindleSshDestination) -> AppResult<()> {
    static HOST: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(
        r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^\[(?:[0-9A-Fa-f:.]+)\]$",
    )
    .expect("valid host regex")
    });
    static USER: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9._-]{1,64}$").expect("valid user regex")
    });
    static SEGMENT: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9._-]{1,120}$").expect("valid path segment regex")
    });
    let root = &destination.remote_root;
    let root_segments = root
        .split('/')
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let has_allowed_library = root_segments.iter().any(|value| {
        value.eq_ignore_ascii_case("documents") || value.eq_ignore_ascii_case("koreader")
    });
    if !HOST.is_match(&destination.host)
        || destination.host.starts_with('-')
        || !USER.is_match(&destination.user)
        || destination.user.starts_with('-')
        || destination.port == 0
        || !root.starts_with("/mnt/us/")
        || root.contains("//")
        || !has_allowed_library
        || root_segments
            .into_iter()
            .any(|value| matches!(value, "." | "..") || !SEGMENT.is_match(value))
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
        return Err(crate::app_error!("invalid-arguments"));
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

fn scp_base(destination: &KindleSshDestination, binary: &str) -> Vec<String> {
    let mut values = ssh_base(destination, binary);
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
    code: crate::error::ErrorCode,
) -> AppResult<CommandOutput> {
    let output = run(command, timeout)?;
    if output.status == 0 {
        Ok(output)
    } else {
        Err(crate::app_error!(code))
    }
}

fn run(command: &mut Command, timeout: Duration) -> AppResult<CommandOutput> {
    const MAX_OUTPUT_BYTES: u64 = 64 * 1024;
    // File-backed capture cannot block a child on a full pipe. Check its size
    // while polling and bound the final read, including output from descendants.
    let mut output = tempfile::tempfile()?;
    command.stdout(Stdio::from(output.try_clone()?));
    let mut child = command
        .spawn()
        .map_err(|_| crate::app_error!("backend-unavailable"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(crate::app_error!("copy-failed"));
            }
        }
        if started.elapsed() >= timeout
            || output
                .metadata()
                .map_or(true, |metadata| metadata.len() > MAX_OUTPUT_BYTES)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(crate::app_error!("copy-failed"));
        }
        thread::sleep(Duration::from_millis(25));
    };
    let mut stdout = String::new();
    output.rewind().map_err(crate::io_error!("copy-failed"))?;
    output
        .take(MAX_OUTPUT_BYTES + 1)
        .read_to_string(&mut stdout)
        .map_err(crate::io_error!("copy-failed"))?;
    if stdout.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(crate::app_error!("copy-failed"));
    }
    Ok(CommandOutput {
        status: status.code().unwrap_or(1),
        stdout,
    })
}

fn fingerprint(path: &Path) -> AppResult<crate::fingerprint::Fingerprint> {
    crate::fingerprint::hash_file(path).map_err(|_| crate::app_error!("source-unavailable"))
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

    #[cfg(unix)]
    #[test]
    fn command_capture_drains_large_output_and_reaps_timeouts() {
        let mut large = Command::new("sh");
        large.args([
            "-c",
            "i=0; while [ $i -lt 20000 ]; do printf 0123456789; i=$((i+1)); done",
        ]);
        assert_eq!(
            run(&mut large, Duration::from_secs(2))
                .err()
                .unwrap()
                .code(),
            "copy-failed"
        );
        let mut small = Command::new("sh");
        small.args(["-c", "printf verified"]);
        assert_eq!(
            run(&mut small, Duration::from_secs(2)).unwrap().stdout,
            "verified"
        );
        let mut timeout = Command::new("sh");
        timeout.args(["-c", "exec sleep 2"]);
        assert_eq!(
            run(&mut timeout, Duration::from_millis(30))
                .err()
                .unwrap()
                .code(),
            "copy-failed"
        );
    }

    #[cfg(unix)]
    fn fake_publish(mode: &str) -> (AppResult<KindleSshResult>, tempfile::TempDir) {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("A book.epub");
        fs::write(&source, b"book bytes").unwrap();
        let identity = root.join("identity");
        fs::write(&identity, b"fake identity").unwrap();
        let hash = fingerprint(&source).unwrap().sha256;
        if mode == "exists" {
            fs::write(root.join("final"), b"original").unwrap();
        }
        let ssh = root.join("ssh");
        let scp = root.join("scp");
        fs::write(
            &ssh,
            format!(
                r#"#!/bin/sh
set -eu
cd '{}'
[ "$1" = -p ] && [ "$2" = 22 ]
[ "$4" = StrictHostKeyChecking=yes ] && [ "$6" = BatchMode=yes ]
[ "$8" = PasswordAuthentication=no ] && [ "$9" = -i ]
shift 11
printf '%s\n' "$*" >> calls
case "$1 $2" in
  'test -d') if [ '{mode}' = root_transport ]; then exit 255; fi; exit 0 ;;
  'test !')
    case '{mode}' in
      transport) exit 255 ;;
      exists) exit 1 ;;
      timeout) exec sleep 2 ;;
    esac
    exit 0 ;;
  'test -e') test -e final ;;
  'sha256sum '*)
    case '{mode}' in
      fallback|size_mismatch) exit 127 ;;
      hash_transport) exit 255 ;;
      hash_mismatch) echo wrong ;;
      *) echo '{hash}  partial' ;;
    esac ;;
  'wc -c')
    if [ '{mode}' = size_mismatch ]; then echo 1; else wc -c partial; fi ;;
  'ln '*)
    case '{mode}' in
      publish_transport) exit 255 ;;
      publish_timeout) exec sleep 2 ;;
      publish_failure) exit 1 ;;
      race) printf original > final ;;
    esac
    ln partial final ;;
  'rm -f') rm -f partial ;;
  *) exit 2 ;;
esac
"#,
                root.display()
            ),
        )
        .unwrap();
        fs::write(
            &scp,
            format!(
                r#"#!/bin/sh
set -eu
[ "$1" = -P ] && [ "$2" = 22 ]
[ "$4" = StrictHostKeyChecking=yes ] && [ "$6" = BatchMode=yes ]
[ "$8" = PasswordAuthentication=no ] && [ "$9" = -i ]
shift 10
printf 'scp\n' >> '{0}/calls'
cp "$1" '{0}/partial'
if [ '{mode}' = copy_failure ]; then exit 1; fi
"#,
                root.display()
            ),
        )
        .unwrap();
        for script in [&ssh, &scp] {
            fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let destination = KindleSshDestination {
            host: "kindle.invalid".into(),
            user: "root".into(),
            port: 22,
            remote_root: "/mnt/us/documents".into(),
            identity_file: identity,
            timeout: Duration::from_secs(if mode.contains("timeout") { 1 } else { 10 }),
        };
        let result = send_with_programs(
            "item",
            &source,
            &destination,
            ssh.to_str().unwrap(),
            scp.to_str().unwrap(),
        );
        (result, temp)
    }

    #[test]
    #[cfg(unix)]
    fn fake_ssh_publishes_verified_bytes_and_cleans_partial() {
        for (mode, verification) in [("success", "sha256"), ("fallback", "size")] {
            let (result, temp) = fake_publish(mode);
            let result = result.unwrap_or_else(|error| {
                panic!(
                    "{mode}: {error}; calls: {:?}",
                    std::fs::read_to_string(temp.path().join("calls"))
                )
            });
            assert_eq!(result.verification, verification);
            assert_eq!(result.path, "/mnt/us/documents/A_book.epub");
            assert_eq!(
                std::fs::read(temp.path().join("final")).unwrap(),
                b"book bytes"
            );
            assert!(!temp.path().join("partial").exists());
            let calls = std::fs::read_to_string(temp.path().join("calls")).unwrap();
            assert!(calls.find("scp").unwrap() < calls.find("sha256sum").unwrap());
            assert!(calls.find("sha256sum").unwrap() < calls.find("ln ").unwrap());
        }
    }

    #[test]
    #[cfg(unix)]
    fn fake_ssh_failures_preserve_existing_files_and_clean_partial() {
        for (mode, code) in [
            ("root_transport", "copy-failed"),
            ("transport", "copy-failed"),
            ("hash_transport", "copy-failed"),
            ("publish_transport", "copy-failed"),
            ("publish_timeout", "copy-failed"),
            ("publish_failure", "copy-failed"),
            ("timeout", "copy-failed"),
            ("copy_failure", "copy-failed"),
            ("exists", "destination-file-exists"),
            ("race", "destination-file-exists"),
            ("hash_mismatch", "verification-failed"),
            ("size_mismatch", "verification-failed"),
        ] {
            let (result, temp) = fake_publish(mode);
            assert_eq!(result.unwrap_err().code(), code, "{mode}");
            assert!(!temp.path().join("partial").exists(), "{mode}");
            if matches!(mode, "race" | "exists") {
                assert_eq!(
                    std::fs::read(temp.path().join("final")).unwrap(),
                    b"original"
                );
            } else {
                assert!(!temp.path().join("final").exists(), "{mode}");
            }
        }
    }

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
