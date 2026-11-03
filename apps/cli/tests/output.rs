use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::{Value, json};

#[test]
fn machine_commands_emit_one_record_and_matching_exit_status()
-> Result<(), Box<dyn std::error::Error>> {
    for (args, status, expected) in [
        (vec!["formats", "--json"], 0, true),
        (vec!["not-a-command"], 1, false),
        (vec!["library", "add"], 1, false),
    ] {
        let output = cargo_bin_cmd!("takio").args(args).output()?;
        assert_eq!(output.status.code(), Some(status));
        assert!(output.stderr.is_empty());
        assert_eq!(output.stdout.iter().filter(|b| **b == b'\n').count(), 1);
        assert_eq!(output.stdout.last(), Some(&b'\n'));
        let envelope: Value = serde_json::from_slice(&output.stdout)?;
        assert_eq!(envelope["ok"], expected);
        if expected {
            assert!(envelope["value"]["formats"].is_array());
        } else {
            assert_eq!(
                envelope,
                json!({"ok": false, "error": {"code": "invalid-arguments"}})
            );
        }
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn closed_stdout_does_not_panic_on_success_or_failure() -> std::io::Result<()> {
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};

    for args in [vec!["formats", "--json"], vec!["not-a-command"]] {
        let (reader, writer) = UnixStream::pair()?;
        drop(reader);
        let output = Command::new(assert_cmd::cargo::cargo_bin!("takio"))
            .args(args)
            .stdout(Stdio::from(OwnedFd::from(writer)))
            .stderr(Stdio::piped())
            .output()?;
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stderr.is_empty(), "{:?}", output.stderr);
    }
    Ok(())
}
