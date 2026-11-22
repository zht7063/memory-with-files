//! `.mwf/config.toml` (ADR 0039).

use std::path::Path;

use serde::Deserialize;

use crate::error::StoreError;

/// Project configuration. Missing tables and keys take their defaults; unknown keys are errors,
/// so a misspelled key does not silently fall back to its default (ADR 0048).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub hooks: HooksConfig,
}

/// `[hooks]`: relevance gate and budgets of the hooks (ADRs 0030, 0039).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HooksConfig {
    /// Distinct prompt terms a page must match to count as relevant.
    pub recall_min_terms: usize,
    /// Relevant pages injected per prompt.
    pub recall_top_k: usize,
    /// Whether the Stop hook reminds the agent to save memories.
    pub stop_reminder: bool,
    /// Character budget of the SessionStart injection.
    pub session_start_max_chars: usize,
}

impl Default for HooksConfig {
    fn default() -> Self {
        HooksConfig {
            recall_min_terms: 2,
            recall_top_k: 3,
            stop_reminder: true,
            session_start_max_chars: 8000,
        }
    }
}

/// The `config.toml` that `init` writes: every key with its default value.
pub const DEFAULT_CONFIG_TOML: &str = "\
# mwf project configuration. A missing key takes the default shown here.

[hooks]
# Distinct prompt terms a page must match before UserPromptSubmit injects it.
recall_min_terms = 2
# Most pages UserPromptSubmit injects per prompt.
recall_top_k = 3
# Remind the agent at Stop to save what is worth remembering.
stop_reminder = true
# Character budget of the SessionStart injection.
session_start_max_chars = 8000
";

impl Config {
    /// Parses `config.toml` text; `path` only labels the error.
    pub fn parse(text: &str, path: &Path) -> Result<Config, StoreError> {
        toml::from_str(text).map_err(|e| StoreError::Config {
            path: path.to_path_buf(),
            message: e.message().to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Config, StoreError> {
        Config::parse(text, Path::new("config.toml"))
    }

    #[test]
    fn default_file_parses_to_defaults() {
        assert_eq!(parse(DEFAULT_CONFIG_TOML).unwrap(), Config::default());
    }

    #[test]
    fn defaults_match_adr_0039() {
        let h = Config::default().hooks;
        assert_eq!(
            (
                h.recall_min_terms,
                h.recall_top_k,
                h.stop_reminder,
                h.session_start_max_chars
            ),
            (2, 3, true, 8000)
        );
    }

    #[test]
    fn empty_file_and_empty_table_use_defaults() {
        assert_eq!(parse("").unwrap(), Config::default());
        assert_eq!(parse("[hooks]\n").unwrap(), Config::default());
    }

    #[test]
    fn missing_keys_keep_their_defaults() {
        let c = parse("[hooks]\nrecall_top_k = 5\nstop_reminder = false\n").unwrap();
        assert_eq!(
            c.hooks,
            HooksConfig {
                recall_top_k: 5,
                stop_reminder: false,
                ..HooksConfig::default()
            }
        );
    }

    #[test]
    fn unknown_keys_and_tables_are_errors() {
        let err = parse("[hooks]\nrecal_top_k = 5\n").unwrap_err();
        assert!(err.to_string().contains("recal_top_k"), "{err}");
        assert!(parse("[search]\nk1 = 1.2\n").is_err());
        assert!(parse("verbose = true\n").is_err());
    }

    #[test]
    fn bad_values_are_errors() {
        assert!(parse("[hooks]\nrecall_top_k = -1\n").is_err());
        assert!(parse("[hooks]\nrecall_top_k = \"3\"\n").is_err());
        assert!(parse("[hooks]\nstop_reminder = 1\n").is_err());
        assert!(parse("hooks = 3\n").is_err());
        assert!(parse("[hooks\n").is_err());
    }

    #[test]
    fn error_names_the_file() {
        let err = Config::parse("[hooks", Path::new("/p/.mwf/config.toml")).unwrap_err();
        assert!(matches!(err, StoreError::Config { .. }));
        assert!(
            err.to_string().starts_with("invalid /p/.mwf/config.toml: "),
            "{err}"
        );
    }
}
