//! The text side of the PreToolUse guard (ADR 0024): the files an `apply_patch` patch names,
//! and a best-effort check of whether a shell command writes under a `.mwf` directory. Paths
//! named by edit tools and patches are checked with `App::is_inside_mwf`, which follows
//! symlinks; shell commands are only scanned as text, so they miss tricks such as variables,
//! `cd .mwf && …` or `eval`; the script of `bash -c` / `sh -lc` is unwrapped and scanned
//! too. The guard is a guardrail, not a security boundary.

/// The paths of the `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:`
/// lines of an `apply_patch` patch. Headers start at column zero; an indented line is hunk
/// context, even when its text looks like a header.
pub fn patch_paths(patch: &str) -> Vec<&str> {
    const HEADERS: [&str; 4] = [
        "*** Add File:",
        "*** Update File:",
        "*** Delete File:",
        "*** Move to:",
    ];
    patch
        .lines()
        .filter_map(|line| {
            let line = line.trim_end();
            HEADERS
                .iter()
                .find_map(|h| line.strip_prefix(h))
                .map(str::trim)
        })
        .filter(|p| !p.is_empty())
        .collect()
}

/// Whether the path `s` (one operand, quotes allowed) has a `.mwf` component (any case, for
/// case-insensitive volumes), as in `.mwf`, `.mwf/pages`, `x/.MWF/log.md`, but not
/// `notes.mwf/a`, `notes+.mwf/a` or `.mwfrc`.
pub fn mentions_mwf(s: &str) -> bool {
    s.trim_matches(['"', '\''])
        .split('/')
        .any(|c| c.eq_ignore_ascii_case(".mwf"))
}

/// Whether the shell command `cmd` looks like it writes under a `.mwf` directory: a redirect
/// into one, or `rm`, `mv`, `cp`, `sed -i` and similar commands with a `.mwf` operand. Each
/// command of a list or pipeline is checked on its own. Commands run as `mwf …` are allowed,
/// since mwf is how `.mwf/` is written, but not a redirect the shell does around them.
/// The script of a `bash -c '…'` (or `sh`, `zsh`, …) is checked the same way, nested ones too.
pub fn shell_writes_mwf(cmd: &str) -> bool {
    writes_at_depth(cmd, 0)
}

/// A shell command line for an argv such as Codex's `["bash", "-lc", "…"]`, each word
/// single-quoted so `shell_writes_mwf` reads the same words back.
pub fn argv_command<'a>(argv: impl IntoIterator<Item = &'a str>) -> String {
    argv.into_iter()
        .map(|w| format!("'{}'", w.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// How deep `bash -c "sh -c '…'"` nesting is unwrapped; deeper scripts are not checked.
const MAX_SHELL_DEPTH: usize = 8;

fn writes_at_depth(cmd: &str, depth: usize) -> bool {
    if !cmd.to_ascii_lowercase().contains(".mwf") {
        return false;
    }
    if depth < MAX_SHELL_DEPTH
        && shell_scripts(cmd)
            .iter()
            .any(|script| writes_at_depth(script, depth + 1))
    {
        return true;
    }
    cmd.replace("&&", "\n")
        .replace("||", "\n")
        .split(['\n', ';', '|'])
        .any(segment_writes)
}

/// Commands that change their operands; any `.mwf` operand counts.
const CHANGES_OPERANDS: [&str; 12] = [
    "rm", "rmdir", "unlink", "shred", "touch", "truncate", "tee", "mkdir", "chmod", "chown", "mv",
    "patch",
];
/// Commands that write only their destination: the last operand or the `-t` directory.
const WRITES_DESTINATION: [&str; 4] = ["cp", "install", "ln", "rsync"];
/// Commands run in front of the real one.
const WRAPPERS: [&str; 8] = [
    "sudo", "env", "command", "exec", "nohup", "time", "xargs", "builtin",
];

/// Shells whose `-c` script is unwrapped.
const SHELLS: [&str; 7] = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"];

/// The scripts passed to `bash -c` and similar shells run as commands of `cmd`, read with
/// shell quoting: `'…'` is literal, `"…"` and bare words honour backslash escapes.
fn shell_scripts(cmd: &str) -> Vec<String> {
    let mut scripts = Vec::new();
    for words in shell_words(cmd).split(Option::is_none) {
        let words: Vec<&str> = words.iter().flatten().map(String::as_str).collect();
        let Some(start) = words
            .iter()
            .position(|w| !(WRAPPERS.contains(w) || (w.contains('=') && !w.starts_with('-'))))
        else {
            continue;
        };
        let name = words[start].rsplit('/').next().unwrap_or(words[start]);
        if !SHELLS.contains(&name) {
            continue;
        }
        let mut has_c = false;
        let mut rest = words[start + 1..].iter();
        while let Some(w) = rest.next() {
            if *w == "--" {
                continue;
            }
            let Some(flags) = w.strip_prefix(['-', '+']) else {
                if has_c {
                    scripts.push((*w).to_owned());
                }
                break;
            };
            if flags.starts_with('-') {
                continue; // `--login`, `--norc`, …
            }
            if let Some(i) = flags.find('c').filter(|_| w.starts_with('-')) {
                has_c = true;
                // An attached script, as in `bash -lc"rm …"`: bash itself rejects the
                // cluster, but a guardrail errs towards checking it.
                if flags.len() > i + 1 {
                    scripts.push(flags[i + 1..].to_owned());
                }
            }
            // `-o pipefail` and `-O extglob` take an argument.
            if flags.contains(['o', 'O']) {
                rest.next();
            }
        }
    }
    scripts
}

/// The words of `cmd` with quotes removed, and `None` for each unquoted `;`, `&`, `|`,
/// newline, `(` or `)` between commands.
fn shell_words(cmd: &str) -> Vec<Option<String>> {
    let mut out = Vec::new();
    let mut word: Option<String> = None;
    let mut chars = cmd.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                let w = word.get_or_insert_with(String::new);
                w.extend(chars.by_ref().take_while(|&c| c != '\''));
            }
            '"' => {
                let w = word.get_or_insert_with(String::new);
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => match chars.next() {
                            Some(e @ ('"' | '\\' | '$' | '`')) => w.push(e),
                            Some('\n') | None => {}
                            Some(e) => {
                                w.push('\\');
                                w.push(e);
                            }
                        },
                        c => w.push(c),
                    }
                }
            }
            '\\' => match chars.next() {
                Some('\n') | None => {}
                Some(e) => word.get_or_insert_with(String::new).push(e),
            },
            c if c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')') => {
                out.extend(word.take().map(Some));
                if !c.is_whitespace() || c == '\n' {
                    out.push(None);
                }
            }
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    out.extend(word.map(Some));
    out
}

fn segment_writes(segment: &str) -> bool {
    let words: Vec<&str> = segment
        .split_whitespace()
        .map(|w| w.trim_matches(['"', '\'']))
        .filter(|w| !w.is_empty())
        .collect();
    let start = words
        .iter()
        .position(|w| !(WRAPPERS.contains(w) || (w.contains('=') && !w.starts_with('-'))))
        .unwrap_or(words.len());
    // The shell opens redirect targets itself, whatever the command is.
    if redirects_into_mwf(segment) {
        return true;
    }
    let Some(first) = words.get(start) else {
        return false;
    };
    let name = first.rsplit('/').next().unwrap_or(first);
    if name == "mwf" {
        return false;
    }
    let args = &words[start + 1..];
    let operands = || args.iter().filter(|a| !a.starts_with('-'));
    if CHANGES_OPERANDS.contains(&name) {
        return operands().any(|a| mentions_mwf(a));
    }
    if WRITES_DESTINATION.contains(&name) {
        let target_dir = args.iter().enumerate().any(|(i, a)| {
            (*a == "-t" && args.get(i + 1).is_some_and(|d| mentions_mwf(d)))
                || a.strip_prefix("--target-directory=")
                    .is_some_and(mentions_mwf)
        });
        return target_dir || operands().next_back().is_some_and(|a| mentions_mwf(a));
    }
    match name {
        // `-i`, `-i.bak`, `--in-place`, or a cluster such as `-ri` / `-pi`.
        "sed" | "perl" | "ruby" => {
            let in_place = args.iter().any(|a| {
                a.starts_with("--in-place")
                    || (a.starts_with('-') && !a.starts_with("--") && a.contains('i'))
            });
            in_place && operands().any(|a| mentions_mwf(a))
        }
        "dd" => args
            .iter()
            .any(|a| a.strip_prefix("of=").is_some_and(mentions_mwf)),
        "find" => {
            args.iter()
                .any(|a| *a == "-delete" || *a == "-exec" || *a == "-execdir")
                && args.iter().any(|a| mentions_mwf(a))
        }
        _ => false,
    }
}

/// Whether `segment` redirects output (`>`, `>>`, `>|`, `2>`, `&>`) into a `.mwf` path.
/// `>&2` and `2>&1` duplicate descriptors and write no file.
fn redirects_into_mwf(segment: &str) -> bool {
    segment.match_indices('>').any(|(i, _)| {
        let rest = segment[i + 1..].trim_start_matches(['>', '|']);
        if rest.starts_with('&') {
            return false;
        }
        let target = rest
            .trim_start()
            .split(|c: char| c.is_whitespace() || c == '<' || c == '>')
            .next()
            .unwrap_or("");
        mentions_mwf(target.trim_matches(['"', '\'']))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_paths_reads_the_file_headers() {
        let patch = "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-x\n+y\n*** Add File: .mwf/pages/n.md\n+hi\n*** Delete File: b.rs\n*** Update File: c.rs\n*** Move to: d.rs\n*** End Patch\n";
        assert_eq!(
            patch_paths(patch),
            ["src/a.rs", ".mwf/pages/n.md", "b.rs", "c.rs", "d.rs"]
        );
        // A `+` line quoting a header is patch content, not a header; so is an indented
        // context line.
        assert!(patch_paths("+*** Add File: .mwf/x.md\n").is_empty());
        let context = "*** Begin Patch\n*** Update File: notes.txt\n@@\n *** Update File: .mwf/pages/a.md\n-x\n+y\n\t*** Delete File: .mwf/log.md\n*** End Patch\n";
        assert_eq!(patch_paths(context), ["notes.txt"]);
    }

    #[test]
    fn mentions_mwf_needs_the_directory_name() {
        for yes in [
            ".mwf",
            ".mwf/",
            "./.mwf/pages/a.md",
            "x/.MWF/log.md",
            "\".mwf/a\"",
            "../.mwf",
        ] {
            assert!(mentions_mwf(yes), "{yes}");
        }
        for no in [
            "mwf",
            ".mwfrc",
            ".mwf-backup/a",
            "a.mwf.bak",
            "src/mwf/x",
            "notes.mwf/a.md",
            "my-.mwf/a",
            "x_.mwf",
            "..mwf/a",
            "notes+.mwf/a",
            "of=.mwf/a",
        ] {
            assert!(!mentions_mwf(no), "{no}");
        }
    }

    #[test]
    fn shell_writes_are_denied() {
        for cmd in [
            "echo hi > .mwf/pages/a.md",
            "echo hi >>.mwf/log.md",
            "cat <<'EOF' > \".mwf/pages/a.md\"\nx\nEOF",
            "printf x 2> .mwf/err",
            "rm -rf .mwf",
            "rm .mwf/pages/a.md",
            "sudo rm .mwf/index.md",
            "mv notes.md .mwf/pages/notes.md",
            "mv .mwf/pages/a.md /tmp/",
            "cp notes.md .mwf/pages/",
            "cp -t .mwf/pages notes.md",
            "sed -i 's/a/b/' .mwf/pages/a.md",
            "sed -i.bak -e s/a/b/ .mwf/pages/a.md",
            "perl -pi -e 's/a/b/' .mwf/pages/a.md",
            "echo x | tee -a .mwf/log.md",
            "touch .mwf/pages/new.md",
            "ls && rm .mwf/pages/a.md",
            "find .mwf -name '*.md' -delete",
            "dd if=/dev/zero of=.mwf/pages/a.md",
            "/bin/rm ../other/.mwf/pages/a.md",
            // The shell, not mwf, writes a redirect target.
            "mwf show a > .mwf/pages/b.md",
            "mwf log >> .mwf/log.md",
            "/usr/local/bin/mwf index 2>.mwf/err",
        ] {
            assert!(shell_writes_mwf(cmd), "{cmd}");
        }
    }

    #[test]
    fn shell_c_scripts_are_unwrapped() {
        for cmd in [
            "bash -c 'rm .mwf/pages/x.md'",
            "bash -lc \"sed -i s/a/b/ .mwf/pages/x.md\"",
            "sh -c 'mv a.md .mwf/pages/x.md'",
            "/bin/zsh -ec 'cp a.md .mwf/pages/'",
            "sudo env X=1 bash -o pipefail -c 'ls; rm .mwf/log.md'",
            "bash --norc -c 'echo hi > .mwf/pages/a.md'",
            "cd /x && bash -c \"cat a | sh -c 'tee .mwf/log.md'\"",
            // Nested quoting and escapes.
            "bash -c \"sh -c 'rm \\\".mwf/pages/x.md\\\"'\"",
            "bash -c 'sh -c \"bash -lc \\\"rm .mwf/a\\\"\"'",
            "bash -c r\\m\\ .mwf/a",
            // From the review of PR #62.
            "bash -lc\"rm .mwf/pages/a.md\"",
            "bash -lc 'rm .mwf/pages/a.md';",
            "bash -lc 'rm .mwf/pages/a.md'&& ls",
            "bash -c 'rm .mwf/a'|cat",
            "env VAR=1 sh -c \"rm .mwf/pages/a.md\"",
            "bash -c -- \"rm .mwf/pages/a.md\"",
            "sh -c \"echo x>.mwf/pages/a.md\"",
            "sh -c \"echo x>>'.mwf/log.md'\"",
        ] {
            assert!(shell_writes_mwf(cmd), "{cmd}");
        }
        // Codex argv, as the hook receives it.
        for argv in [
            &["bash", "-lc", "rm .mwf/pages/x.md"][..],
            &["sh", "-c", "sed -i 's/a/b/' .mwf/pages/x.md"],
            &["bash", "-c", "bash -c 'mv x .mwf/pages/y.md'"],
            &["rm", ".mwf/it's.md"],
        ] {
            assert!(
                shell_writes_mwf(&argv_command(argv.iter().copied())),
                "{argv:?}"
            );
        }
        for cmd in [
            "bash -c 'cat .mwf/index.md'",
            "bash -lc 'mwf show a'",
            "sh -c 'grep -rn x .mwf | head'",
            "bash script.sh .mwf",
            "bash -c 'echo rm' .mwf",
        ] {
            assert!(!shell_writes_mwf(cmd), "{cmd}");
        }
        assert!(!shell_writes_mwf(&argv_command([
            "bash",
            "-lc",
            "cat .mwf/log.md"
        ])));
    }

    #[test]
    fn reads_and_mwf_itself_are_allowed() {
        for cmd in [
            "cat .mwf/index.md",
            "grep -rn foo .mwf/pages",
            "ls -la .mwf",
            "cat .mwf/pages/a.md > /tmp/a.md",
            "cp .mwf/pages/a.md /tmp/a.md",
            "sed -n 1,5p .mwf/log.md",
            "mwf show a",
            "mwf new a --type knowledge --title A --summary 'see .mwf > x' < body.md",
            "git diff -- .mwf 2>&1",
            "rm -rf target",
            "echo hi > notes.md",
            "find .mwf -name '*.md'",
            "mwf show a > notes.md",
            // `.mwf` must be a whole path component.
            "rm -rf notes.mwf/old",
            "echo x > build.mwf/out",
            "sed -i s/a/b/ docs/a.mwf/x.md",
            "rm notes+.mwf/a",
            "echo x > notes+.mwf/a",
        ] {
            assert!(!shell_writes_mwf(cmd), "{cmd}");
        }
    }
}
