//! The injectable clock (ADRs 0043, 0046). `mwf-domain` never reads the time; `mwf-app` asks its
//! [`Clock`] and converts with `Timestamp::from_unix_secs`.

use std::time::{SystemTime, UNIX_EPOCH};

/// Source of the current time, in whole seconds since the Unix epoch (UTC).
pub trait Clock: Send + Sync {
    fn now_unix_secs(&self) -> u64;
}

/// The system clock. A clock set before 1970 reads as the epoch.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix_secs(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    }
}

/// A clock stopped at the given Unix second, for tests and snapshot output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixedClock(pub u64);

impl Clock for FixedClock {
    fn now_unix_secs(&self) -> u64 {
        self.0
    }
}
