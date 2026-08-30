fn main() {
    if let Err(error) = takio::run() {
        println!("{}", takio::output::failure_line(error.code()));
        std::process::exit(error.exit_code());
    }
}
