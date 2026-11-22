//! The `mwf` binary only dispatches the first argument to an adapter
//! (docs/crates/adapters.md): `hook` goes to mwf-hooks, `install` / `uninstall` to
//! mwf-lifecycle, everything else to mwf-cli.

use std::ffi::OsString;
use std::process::ExitCode;

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
    // `--json` is global and may come before the command (ADR 0050).
    if args
        .iter()
        .skip(1)
        .find(|a| *a != "--json")
        .is_some_and(|a| a == "install" || a == "uninstall")
    {
        return mwf_lifecycle::run(
            args[1..].to_vec(),
            &mut mwf_lifecycle::Io {
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
