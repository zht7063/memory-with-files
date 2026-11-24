//! Pure data: the `mwf` skill, hook prompt text and `init` templates.
//!
//! See [docs/crates/adapters.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/adapters.md).
//!
//! The files `init` writes into `.mwf/` (`config.toml`, `.gitignore`) live in `mwf-store`, which
//! parses them and cannot depend on this crate; here is only the text `mwf-app` returns from
//! `init` (ADR 0049). The hook text is what `mwf-hooks` says around the data it injects and
//! when it refuses an edit (ADRs 0024, 0051).

/// What to do after `mwf init` in git mode (`.mwf/` is committed).
pub const INIT_NEXT_STEPS_GIT: &str = include_str!("../templates/init-next-steps-git.txt");

/// What to do after `mwf init --local` (`.mwf/` is ignored).
pub const INIT_NEXT_STEPS_LOCAL: &str = include_str!("../templates/init-next-steps-local.txt");

/// The line in front of the fenced SessionStart context (ADR 0051).
pub const HOOK_SESSION_START_INTRO: &str =
    include_str!("../templates/hook-session-start-intro.txt");

/// The line in front of the fenced pages a prompt recalls (ADR 0051).
pub const HOOK_PROMPT_INTRO: &str = include_str!("../templates/hook-prompt-intro.txt");

/// What the Stop hook tells the agent once per turn, following the ingest steps of ADR 0040.
pub const HOOK_STOP_REMINDER: &str = include_str!("../templates/hook-stop-reminder.txt");

/// Why PreToolUse refuses a file edit under `.mwf/` (ADR 0024).
pub const HOOK_DENY_EDIT: &str = include_str!("../templates/hook-deny-edit.txt");

/// Why PreToolUse refuses a shell command that looks like it writes under `.mwf/` (ADR 0024).
pub const HOOK_DENY_SHELL: &str = include_str!("../templates/hook-deny-shell.txt");

/// pi's bridge extension (ADR 0055): `mwf install --host pi` writes it as
/// `extensions/mwf/index.ts`, replacing [`PI_EXTENSION_PROGRAM`] with the program to run as a
/// JSON string literal.
pub const PI_EXTENSION_TS: &str = include_str!("../templates/pi-extension.ts");

/// The placeholder for the program in [`PI_EXTENSION_TS`].
pub const PI_EXTENSION_PROGRAM: &str = "__MWF_PROGRAM__";

/// The one skill (ADR 0036): its directory name and the `name:` in its frontmatter.
pub const SKILL_NAME: &str = "mwf";

/// The skill's `SKILL.md`: when to read and write the wiki and how to maintain it (ADRs 0036, 0040).
pub const SKILL_MD: &str = include_str!("../skill/SKILL.md");

/// The skill's `references/commands.md`: the commands of docs/cli.md at a glance.
pub const SKILL_COMMANDS_MD: &str = include_str!("../skill/references/commands.md");

/// The skill's files as (path relative to the skill directory, contents), for `mwf install`.
pub const SKILL_FILES: &[(&str, &str)] = &[
    ("SKILL.md", SKILL_MD),
    ("references/commands.md", SKILL_COMMANDS_MD),
];

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    /// The CLI spec the skill must match.
    const CLI_MD: &str = include_str!("../../../docs/cli.md");

    /// `(name, description)` from the `---` frontmatter at the top of `SKILL.md`.
    fn frontmatter(md: &str) -> (String, String) {
        let rest = md.strip_prefix("---\n").expect("SKILL.md starts with ---");
        let (block, _) = rest
            .split_once("\n---\n")
            .expect("frontmatter is closed by ---");
        let mut name = None;
        let mut description = None;
        for line in block.lines() {
            let (key, value) = line.split_once(": ").expect("`key: value` line");
            let slot = match key {
                "name" => &mut name,
                "description" => &mut description,
                other => panic!("unexpected frontmatter key {other:?}"),
            };
            assert!(
                slot.replace(value.to_owned()).is_none(),
                "duplicate key {key}"
            );
        }
        (name.expect("name"), description.expect("description"))
    }

    /// Subcommands named in fenced code blocks of docs/cli.md (lines starting `mwf <cmd>`).
    fn cli_commands() -> BTreeSet<&'static str> {
        let mut inside = false;
        let mut out = BTreeSet::new();
        for line in CLI_MD.lines() {
            if line.starts_with("```") {
                inside = !inside;
            } else if inside && let Some(rest) = line.strip_prefix("mwf ") {
                out.insert(rest.split_whitespace().next().expect("a subcommand"));
            }
        }
        assert!(
            out.len() >= 15,
            "parsed too few commands from docs/cli.md: {out:?}"
        );
        out
    }

    /// Words right after `` `mwf `` in `md`: the commands it tells the agent to run.
    fn mentioned_commands(md: &str) -> BTreeSet<&str> {
        md.match_indices("`mwf ")
            .map(|(i, m)| {
                let rest = &md[i + m.len()..];
                let end = rest
                    .find(|c: char| !(c.is_ascii_lowercase() || c == '-'))
                    .unwrap_or(rest.len());
                &rest[..end]
            })
            .collect()
    }

    /// Long options (`--name`) and `-n` used in `md`.
    fn options(md: &str) -> BTreeSet<&str> {
        let mut out = BTreeSet::new();
        for (i, _) in md.match_indices('-') {
            let before = md[..i].chars().next_back();
            if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-') {
                continue;
            }
            let rest = &md[i..];
            let end = 1 + rest[1..]
                .find(|c: char| !(c.is_ascii_lowercase() || c == '-'))
                .unwrap_or(rest.len() - 1);
            let opt = &rest[..end];
            if opt.starts_with("--") && opt.len() > 2 || opt == "-n" {
                out.insert(opt);
            }
        }
        out
    }

    /// `ALL_CAPS` error codes written as code spans in `md`.
    fn error_codes(md: &str) -> BTreeSet<&str> {
        md.split('`')
            .skip(1)
            .step_by(2)
            .filter(|s| {
                s.len() > 2
                    && s.contains('_')
                    && s.chars().all(|c| c.is_ascii_uppercase() || c == '_')
            })
            .collect()
    }

    #[test]
    fn skill_files_are_the_two_embedded_files() {
        let paths: Vec<_> = SKILL_FILES.iter().map(|(p, _)| *p).collect();
        assert_eq!(paths, ["SKILL.md", "references/commands.md"]);
        for (path, text) in SKILL_FILES {
            assert!(text.trim().len() > 500, "{path} is too short");
            assert!(
                text.ends_with('\n') && !text.ends_with("\n\n"),
                "{path}: one final newline"
            );
            assert!(
                !text.contains('\r') && !text.contains('\t'),
                "{path}: no CR or tab"
            );
        }
        assert!(
            SKILL_MD.contains("](references/commands.md)"),
            "SKILL.md links to the command reference"
        );
    }

    #[test]
    fn skill_frontmatter_names_the_skill() {
        let (name, description) = frontmatter(SKILL_MD);
        assert_eq!(name, SKILL_NAME);
        // Hosts list skills by this line; Claude Code and Codex cap it at 1024 characters.
        assert!((100..=1024).contains(&description.chars().count()));
        assert!(!description.contains(['"', '\'', '#']), "plain YAML scalar");
        assert!(
            !SKILL_COMMANDS_MD.starts_with("---"),
            "only SKILL.md has frontmatter"
        );
    }

    #[test]
    fn skill_has_the_sections_adr_0036_and_0040_ask_for() {
        for heading in [
            "\n# mwf: the project wiki\n",
            "\n## Rules\n",
            "\n## Pages\n",
            "\n## When to read\n",
            "\n## When to write\n",
            "\n### Task handoffs\n",
            "\n## Tidying the wiki\n",
        ] {
            assert!(SKILL_MD.contains(heading), "SKILL.md lacks {heading:?}");
        }
        // The task handoff structure (ADR 0017).
        for heading in ["## Progress", "## Next steps", "## Blockers"] {
            assert!(SKILL_MD.contains(heading), "handoff lacks {heading}");
        }
        for t in ["preference", "decision", "knowledge", "incident", "task"] {
            assert!(
                SKILL_MD.contains(&format!("| `{t}` |")),
                "type {t} not described"
            );
            assert!(
                SKILL_COMMANDS_MD.contains(&format!("`{t}`")),
                "type {t} not listed"
            );
        }
        for heading in [
            "## Read\n",
            "## Write\n",
            "## Project and hosts\n",
            "## Errors to handle\n",
        ] {
            assert!(
                SKILL_COMMANDS_MD.contains(heading),
                "commands.md lacks {heading:?}"
            );
        }
    }

    #[test]
    fn markdown_fences_and_tables_are_well_formed() {
        for (path, text) in SKILL_FILES {
            let fences = text.lines().filter(|l| l.starts_with("```")).count();
            assert_eq!(fences % 2, 0, "{path}: unclosed code fence");
            // Rows of one table have as many unescaped `|` as its header.
            let mut columns = None;
            for line in text.lines() {
                if line.starts_with('|') {
                    let pipes = line.replace("\\|", "").matches('|').count();
                    let header = *columns.get_or_insert(pipes);
                    assert_eq!(pipes, header, "{path}: ragged table row {line:?}");
                } else {
                    columns = None;
                }
            }
        }
    }

    #[test]
    fn every_cli_command_is_in_the_reference_and_no_other() {
        let cli = cli_commands();
        let reference = mentioned_commands(SKILL_COMMANDS_MD);
        assert_eq!(
            reference, cli,
            "commands.md and docs/cli.md list different commands"
        );
        let skill = mentioned_commands(SKILL_MD);
        assert!(
            skill.is_subset(&cli),
            "SKILL.md names unknown commands: {:?}",
            &skill - &cli
        );
    }

    #[test]
    fn options_and_error_codes_exist_in_the_cli_spec() {
        for (path, text) in SKILL_FILES {
            for opt in options(text) {
                assert!(CLI_MD.contains(opt), "{path}: {opt} is not in docs/cli.md");
            }
            for code in error_codes(text) {
                assert!(
                    CLI_MD.contains(&format!("`{code}`")),
                    "{path}: unknown error {code}"
                );
            }
        }
        // The checks above are not vacuous.
        assert!(options(SKILL_COMMANDS_MD).contains("--old-file"));
        assert!(error_codes(SKILL_COMMANDS_MD).contains("REV_MISMATCH"));
    }

    #[test]
    fn no_1x_vocabulary() {
        // 1.x used MCP tools, slash commands, `[[slug]]` links, inbox / handoff records and
        // TTY-confirmed destructive commands; 2.0 has none of them (ADRs 0009, 0017, 0026, 0038).
        for (path, text) in SKILL_FILES {
            for stale in [
                "mwf_",
                "/mwf",
                "[[",
                "MCP",
                "--confirm",
                "bootstrap",
                "recall",
                "propose",
                "inbox",
                "forget",
                "purge",
                "compact",
                "reindex",
                "doctor",
                "mwf-save",
                "mwf-handoff",
                "mwf-tidy",
                "paths:",
            ] {
                assert!(!text.contains(stale), "{path} mentions 1.x {stale:?}");
            }
        }
    }

    const HOOK_TEXTS: [(&str, &str); 5] = [
        ("hook-session-start-intro", HOOK_SESSION_START_INTRO),
        ("hook-prompt-intro", HOOK_PROMPT_INTRO),
        ("hook-stop-reminder", HOOK_STOP_REMINDER),
        ("hook-deny-edit", HOOK_DENY_EDIT),
        ("hook-deny-shell", HOOK_DENY_SHELL),
    ];

    #[test]
    fn pi_extension_has_one_program_placeholder_and_runs_the_four_events() {
        assert_eq!(PI_EXTENSION_TS.matches(PI_EXTENSION_PROGRAM).count(), 1);
        for event in [
            "\"session-start\"",
            "\"prompt\"",
            "\"stop\"",
            "\"pre-tool\"",
        ] {
            assert!(PI_EXTENSION_TS.contains(event), "{event}");
        }
        assert!(PI_EXTENSION_TS.contains("\"--host\", \"pi\""));
    }

    #[test]
    fn hook_texts_are_single_lines_naming_real_commands() {
        let cli = cli_commands();
        for (name, text) in HOOK_TEXTS {
            let line = text.strip_suffix('\n').expect("one final newline");
            assert!(
                !line.is_empty() && !line.contains(['\n', '\r', '\t']),
                "{name}: one line"
            );
            assert!(line.starts_with("mwf: "), "{name}: says it is mwf");
            let named = mentioned_commands(line);
            assert!(
                named.is_subset(&cli),
                "{name}: unknown commands {:?}",
                &named - &cli
            );
            for opt in options(line) {
                assert!(CLI_MD.contains(opt), "{name}: {opt} is not in docs/cli.md");
            }
            for stale in ["mwf_", "/mwf", "[[", "MCP", "doctor", "recall"] {
                assert!(!line.contains(stale), "{name} mentions 1.x {stale:?}");
            }
        }
        // The ingest steps of ADR 0040.
        for step in ["`mwf search", "`mwf patch`", "`mwf new`", "do nothing"] {
            assert!(HOOK_STOP_REMINDER.contains(step), "reminder lacks {step}");
        }
    }
}
