#![cfg(unix)]

use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn unresolved_working_directory(stderr: Stdio, benchmark: bool) -> std::io::Result<Output> {
    let fixture = tempfile::tempdir()?;
    let working = fixture.path().join("removed-cwd");
    std::fs::create_dir(&working)?;
    // Only the disposable empty directory is removed. A relative data directory
    // then fails resolution before GPUI or a library can be opened.
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            "cd \"$1\" && /bin/rmdir \"$1\" && exec \"$2\"",
            "startup-test",
        ])
        .arg(&working)
        .arg(env!("CARGO_BIN_EXE_takio-desktop"))
        .env("TAKIO_DATA_DIR", "relative-library")
        .env_remove("TAKIO_DESKTOP_BENCH")
        .env_remove("TAKIO_SNAPSHOT_OUTPUT")
        .stdout(Stdio::piped())
        .stderr(stderr);
    if benchmark {
        command.env("TAKIO_DESKTOP_BENCH", "1");
    }
    let mut child = command.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait()?.is_none() {
        if Instant::now() >= deadline {
            child.kill()?;
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "native startup did not reject the removed working directory",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output()
}

#[test]
fn path_resolution_failure_returns_failure_and_one_diagnostic() -> std::io::Result<()> {
    for benchmark in [false, true] {
        let output = unresolved_working_directory(Stdio::piped(), benchmark)?;
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let expected = if benchmark {
            "takio-desktop: storage-unavailable\n"
        } else {
            "takio-desktop: could not resolve library path: storage-unavailable\n"
        };
        assert_eq!(output.stderr, expected.as_bytes());
    }
    Ok(())
}

#[test]
fn closed_stderr_does_not_turn_startup_failure_into_a_panic() -> std::io::Result<()> {
    for benchmark in [false, true] {
        let (reader, writer) = UnixStream::pair()?;
        drop(reader);
        let output = unresolved_working_directory(Stdio::from(OwnedFd::from(writer)), benchmark)?;
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
    }
    Ok(())
}
