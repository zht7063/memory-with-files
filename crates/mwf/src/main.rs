//! The `mwf` binary only dispatches the first argument to an adapter
//! (docs/crates/adapters.md). `hook` (mwf-hooks, P3) and `install` / `uninstall`
//! (mwf-lifecycle, P4) are routed here once those adapters exist; until then every
//! command goes to mwf-cli.

use std::process::ExitCode;

// Dependency edges from docs/architecture.md; real uses replace these.
use mwf_hooks as _;
use mwf_lifecycle as _;

fn main() -> ExitCode {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut stderr = std::io::stderr().lock();
    mwf_cli::run(
        std::env::args_os().collect(),
        &mut mwf_cli::Io {
            stdin: &mut stdin,
            stdout: &mut stdout,
            stderr: &mut stderr,
        },
    )
}
