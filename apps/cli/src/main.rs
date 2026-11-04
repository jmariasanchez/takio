use std::io::Write;
use std::process::ExitCode;

mod cli;
mod output;
mod server;
mod tui;

fn main() -> ExitCode {
    match cli::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // A closed output pipe cannot receive an error envelope either.
            let _ = writeln!(
                std::io::stdout().lock(),
                "{}",
                output::app_failure_line(&error)
            );
            ExitCode::from(u8::try_from(error.exit_code()).unwrap_or(1))
        }
    }
}
