use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    match takio::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // A closed output pipe cannot receive an error envelope either.
            let _ = writeln!(
                std::io::stdout().lock(),
                "{}",
                takio::output::failure_line(error.code())
            );
            ExitCode::from(u8::try_from(error.exit_code()).unwrap_or(1))
        }
    }
}
