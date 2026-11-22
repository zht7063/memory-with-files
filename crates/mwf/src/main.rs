//! The `mwf` binary only dispatches the first argument to an adapter
//! (docs/crates/adapters.md): `hook` goes to mwf-hooks, everything else to mwf-cli.
//! `install` / `uninstall` (mwf-lifecycle, P4) are routed here once that adapter exists.

use std::ffi::OsString;
use std::process::ExitCode;

// Dependency edge from docs/architecture.md; the real use replaces it in P4.
use mwf_lifecycle as _;

fn main() -> ExitCode {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut stderr = std::io::stderr().lock();
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == "hook") {
        return mwf_hooks::run(
            args[2..].to_vec(),
            &mut mwf_hooks::Io {
                stdin: &mut stdin,
                stdout: &mut stdout,
                stderr: &mut stderr,
            },
        );
    }
    mwf_cli::run(
        args,
        &mut mwf_cli::Io {
            stdin: &mut stdin,
            stdout: &mut stdout,
            stderr: &mut stderr,
        },
    )
}
