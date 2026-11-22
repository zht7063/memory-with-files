//! Pure data: the `mwf` skill, hook prompt text and `init` templates.
//!
//! See [docs/crates/adapters.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/adapters.md).
//!
//! The files `init` writes into `.mwf/` (`config.toml`, `.gitignore`) live in `mwf-store`, which
//! parses them and cannot depend on this crate; here is only the text `mwf-app` returns from
//! `init` (ADR 0049). The skill and hook text arrive in P3.

/// What to do after `mwf init` in git mode (`.mwf/` is committed).
pub const INIT_NEXT_STEPS_GIT: &str = include_str!("../templates/init-next-steps-git.txt");

/// What to do after `mwf init --local` (`.mwf/` is ignored).
pub const INIT_NEXT_STEPS_LOCAL: &str = include_str!("../templates/init-next-steps-local.txt");
