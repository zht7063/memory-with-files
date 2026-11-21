//! All file IO under `.mwf/`: layout, project lookup, atomic writes, write lock, config, log, trash, session state.
//!
//! See [docs/crates/mwf-store.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/mwf-store.md).

// Dependency edges from docs/architecture.md; real uses replace these.
use mwf_domain as _;
