//! End-to-end tests: the compiled `mwf` binary in temporary git roots (ADR 0021). Plain-text
//! and `--json` output are pinned as `insta` snapshots of whole sessions; the formats are
//! described in ADR 0050.
//!
//! Only the binary is tested here: depending on workspace crates, even as dev-dependencies,
//! would add edges that `.github/scripts/check-crate-graph.sh` rejects.

// Tests may unwrap and panic (ADR 0043); clippy.toml's test exemption does not reach the
// helper functions of an integration test crate.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::process::Output;

use assert_cmd::cargo::cargo_bin_cmd;
use tempfile::TempDir;

/// The CLI's stdin limit (ADR 0033).
const STDIN_MAX: usize = 1024 * 1024;

/// A git root (a `.git` directory is enough, ADR 0048) and a transcript of the commands run in
/// it.
struct Session {
    dir: TempDir,
    root: PathBuf,
    transcript: String,
}

impl Session {
    fn new() -> Session {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        Session {
            dir,
            root,
            transcript: String::new(),
        }
    }

    fn initialized() -> Session {
        let s = Session::new();
        assert!(s.output(&["init"], "").status.success());
        s
    }

    fn output(&self, args: &[&str], stdin: impl Into<Vec<u8>>) -> Output {
        cargo_bin_cmd!("mwf")
            .args(args)
            .current_dir(&self.root)
            .write_stdin(stdin)
            .output()
            .unwrap()
    }

    /// Runs `mwf args` and appends the command, its stdin, stdout, stderr and exit code to the
    /// transcript. Returns stdout.
    fn run(&mut self, args: &[&str], stdin: &str) -> String {
        let out = self.output(args, stdin);
        let stdout = String::from_utf8(out.stdout).unwrap();
        let stderr = String::from_utf8(out.stderr).unwrap();
        let t = &mut self.transcript;
        let _ = writeln!(t, "{}", format!("$ mwf {}", shell_words(args)).trim_end());
        if !stdin.is_empty() {
            for line in stdin.lines() {
                let _ = writeln!(t, "< {line}");
            }
        }
        t.push_str(&stdout);
        for line in stderr.lines() {
            let _ = writeln!(t, "[stderr] {line}");
        }
        let _ = writeln!(t, "[exit {}]\n", out.status.code().unwrap());
        stdout
    }

    /// The `rev:` line of `mwf show slug`.
    fn rev(&self, slug: &str) -> String {
        let out = String::from_utf8(self.output(&["show", slug], "").stdout).unwrap();
        out.lines()
            .find_map(|l| l.strip_prefix("rev: "))
            .unwrap()
            .to_owned()
    }

    /// Snapshots the transcript with the parts that change between runs replaced.
    fn snapshot(&self, name: &str) {
        let mut filters = vec![
            (
                regex_escape(&self.root.display().to_string()),
                "[ROOT]".to_owned(),
            ),
            (
                regex_escape(&self.dir.path().display().to_string()),
                "[ROOT]".to_owned(),
            ),
        ];
        filters.extend([
            (
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z".to_owned(),
                "[TIME]".to_owned(),
            ),
            (r"\b[0-9a-f]{12}\b".to_owned(), "[REV]".to_owned()),
        ]);
        let filters: Vec<(&str, &str)> = filters
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        insta::with_settings!({ filters => filters, prepend_module_to_snapshot => false }, {
            insta::assert_snapshot!(name, self.transcript);
        });
    }
}

fn shell_words(args: &[&str]) -> String {
    args.iter()
        .map(|a| {
            if !a.is_empty()
                && a.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-./_".contains(c))
            {
                (*a).to_owned()
            } else {
                format!("'{a}'")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn regex_escape(s: &str) -> String {
    s.chars()
        .map(|c| {
            if "\\.+*?()|[]{}^$#&-~".contains(c) {
                format!("\\{c}")
            } else {
                c.to_string()
            }
        })
        .collect()
}

#[test]
fn text_session() {
    let mut s = Session::new();
    s.run(&["init"], "");
    s.run(
        &[
            "new", "auth-flow", "--type", "knowledge", "--title", "Auth flow", "--summary",
            "How login tokens are issued and refreshed", "--tag", "auth", "--tag", "api",
        ],
        "Tokens come from [the session store](session-store.md).\nRefresh tokens rotate on every login.\n",
    );
    s.run(
        &[
            "new",
            "session-store",
            "--type",
            "decision",
            "--title",
            "Session store",
            "--summary",
            "Sessions and refresh tokens live in Redis",
        ],
        "We keep login sessions and refresh tokens in Redis.\n",
    );
    s.run(&["show", "auth-flow"], "");
    s.run(&["list"], "");
    s.run(&["search", "refresh", "tokens"], "");
    s.run(&["search", "redis", "--type", "knowledge"], "");
    s.run(
        &[
            "patch",
            "auth-flow",
            "--old",
            "on every login",
            "--new",
            "on every use",
        ],
        "",
    );
    s.run(
        &["patch", "auth-flow", "--old", "no such text", "--new", "x"],
        "",
    );
    s.run(
        &[
            "set",
            "auth-flow",
            "--summary",
            "How tokens are issued",
            "--untag",
            "api",
        ],
        "",
    );
    s.run(
        &["set", "auth-flow", "--summary", "How tokens are issued"],
        "",
    );
    let rev = s.rev("session-store");
    s.run(
        &["write", "session-store", "--rev", &rev],
        "Sessions live in Redis; see [auth](auth-flow.md).\n",
    );
    s.run(&["write", "session-store", "--rev", &rev], "stale\n");
    s.run(&["archive", "session-store"], "");
    s.run(&["list", "--status", "archived"], "");
    s.run(&["unarchive", "session-store"], "");
    s.run(&["rename", "session-store", "sessions"], "");
    s.run(&["show", "sessions"], "");
    s.run(&["delete", "sessions"], "");
    s.run(&["delete", "sessions", "--unlink"], "");
    s.run(&["list", "--status", "all"], "");
    s.run(&["search", "nothing-matches-this"], "");
    s.run(&["log", "-n", "3"], "");
    s.run(&["index"], "");
    s.run(&["lint"], "");
    s.snapshot("text_session");
}

#[test]
fn json_session() {
    let mut s = Session::new();
    s.run(&["--json", "init", "--local"], "");
    s.run(
        &[
            "new",
            "deploy",
            "--type",
            "task",
            "--title",
            "Deploy",
            "--summary",
            "Ship it",
            "--tag",
            "ops",
            "--json",
        ],
        "Run the [release](release.md) script.\n",
    );
    s.run(&["show", "deploy", "--json"], "");
    s.run(&["list", "--json"], "");
    s.run(&["search", "release", "--json"], "");
    s.run(
        &["write", "deploy", "--rev", "000000000000", "--json"],
        "x\n",
    );
    s.run(&["log", "--json"], "");
    s.run(&["index", "--rebuild", "--json"], "");
    s.run(&["lint", "--json"], "");
    s.run(&["delete", "deploy", "--json"], "");
    s.run(&["show", "deploy", "--json"], "");
    s.snapshot("json_session");
}

#[test]
fn errors() {
    let mut s = Session::new();
    s.run(&["show", "x"], "");
    s.run(&["show", "x", "--json"], "");
    s.run(&["init"], "");
    s.run(&["init", "--json"], "");
    s.run(&["show", "Not_A_Slug"], "");
    s.run(
        &[
            "new",
            "x",
            "--type",
            "nonsense",
            "--title",
            "X",
            "--summary",
            "x",
        ],
        "",
    );
    // Usage errors: exit 2, `USAGE` in `--json`.
    s.run(&[], "");
    s.run(&["frobnicate"], "");
    s.run(&["frobnicate", "--json"], "");
    s.run(&["new", "x"], "");
    s.run(&["--json", "new", "x"], "");
    s.run(&["list", "--status", "gone", "--json"], "");
    s.run(&["log", "-n", "many"], "");
    s.run(
        &[
            "patch",
            "x",
            "--old",
            "a",
            "--old-file",
            "a.txt",
            "--new",
            "b",
        ],
        "",
    );
    s.snapshot("errors");
}

#[test]
fn help_and_version() {
    let mut s = Session::new();
    s.run(&["--help"], "");
    s.run(&["new", "--help"], "");
    s.run(&["patch", "--help"], "");
    s.run(&["search", "--help"], "");
    s.snapshot("help");

    let out = s.output(&["--version"], "");
    assert!(out.status.success());
    let version = String::from_utf8(out.stdout).unwrap();
    assert_eq!(version, format!("mwf {}\n", env!("CARGO_PKG_VERSION")));
}

/// Values that start with `-` (Markdown list items) are text, not options.
#[test]
fn hyphen_values_and_patch_files() {
    let mut s = Session::initialized();
    s.run(
        &[
            "new",
            "todo",
            "--type",
            "task",
            "--title",
            "-Todo",
            "--summary",
            "- open items",
        ],
        "- one\n- two\n",
    );
    s.run(&["patch", "todo", "--old", "- two", "--new", "- three"], "");
    fs::write(s.root.join("old.txt"), "- one\n").unwrap();
    fs::write(s.root.join("new.txt"), "- first\n").unwrap();
    s.run(
        &[
            "patch",
            "todo",
            "--old-file",
            "old.txt",
            "--new-file",
            "new.txt",
        ],
        "",
    );
    s.run(
        &["patch", "todo", "--old-file", "missing.txt", "--new", "x"],
        "",
    );
    s.run(&["show", "todo"], "");
    s.snapshot("hyphen_values_and_patch_files");
}

/// stdin over 1 MB fails in the CLI, before `mwf-app`'s 100 KB body check (ADR 0033).
#[test]
fn stdin_limit() {
    let s = Session::initialized();
    let new = [
        "new",
        "big",
        "--type",
        "task",
        "--title",
        "Big",
        "--summary",
        "s",
        "--json",
    ];

    let out = s.output(&new, vec![b'a'; STDIN_MAX + 1]);
    assert_eq!(out.status.code(), Some(1));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.starts_with(r#"{"ok":false,"error":{"code":"TOO_LARGE","#),
        "{stdout}"
    );
    assert!(
        stdout.contains(r#""details":{"field":"stdin","limit":1048576}"#),
        "{stdout}"
    );

    // Exactly 1 MB passes the CLI, then the body limit rejects it.
    let out = s.output(&new, vec![b'a'; STDIN_MAX]);
    assert_eq!(out.status.code(), Some(1));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains(r#""code":"TOO_LARGE""#), "{stdout}");
    assert!(stdout.contains(r#""field":"body""#), "{stdout}");

    let out = s.output(&new, vec![0xff, 0xfe]);
    assert_eq!(out.status.code(), Some(1));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains(r#""code":"INVALID_FIELD""#), "{stdout}");

    let out = s.output(&["list"], "");
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "no pages\n");
}

/// `lint` exits 1 when it finds an error, in both output modes; `--json` still reports
/// `"ok": true` with the report as data.
#[test]
fn lint_errors_exit_1() {
    let mut s = Session::initialized();
    fs::write(s.root.join(".mwf/pages/Bad_Name.md"), "no frontmatter\n").unwrap();
    s.run(&["lint"], "");
    s.run(&["lint", "--json"], "");
    s.snapshot("lint_errors");
}

/// A credential-looking string, assembled at run time so the source holds no literal secret
/// (GitHub push protection). It is also a valid slug.
fn canary() -> String {
    ["glpat", "-", "zq8xk2mn7pr4vt9wb3cd6fg1"].concat()
}

/// Neither stream of `out` contains `secret`; returns stdout and stderr joined.
fn assert_withheld(out: &Output, secret: &str) -> String {
    let all = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!all.contains(secret), "{all}");
    assert!(all.contains("withheld"), "{all}");
    all
}

/// clap diagnostics echo rejected values; a secret-looking one is withheld in both modes.
#[test]
fn usage_errors_withhold_secret_arguments() {
    let s = Session::new();
    let key = canary();
    let flag = format!("--{key}");
    for args in [
        vec!["list", "--status", key.as_str()],
        vec!["list", "--json", "--status", key.as_str()],
        vec!["list", flag.as_str()],
        vec!["list", key.as_str(), "--json"],
    ] {
        let out = s.output(&args, "");
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert_withheld(&out, &key);
    }
    let status = format!("--status={key}");
    let out = s.output(&["list", &status], "");
    assert_eq!(out.status.code(), Some(2));
    assert_withheld(&out, &key);
    let out = s.output(&["log", &format!("-n{key}")], "");
    assert_eq!(out.status.code(), Some(2));
    assert_withheld(&out, &key);
    let json =
        String::from_utf8(s.output(&["list", "--json", "--status", &key], "").stdout).unwrap();
    assert!(
        json.starts_with(r#"{"ok":false,"error":{"code":"USAGE","#),
        "{json}"
    );
}

/// A missing `--old-file` / `--new-file` with a secret-looking name is reported without it.
#[test]
fn patch_file_errors_withhold_secret_paths() {
    let s = Session::initialized();
    let path = format!("{}.txt", canary());
    let out = s.output(&["patch", "x", "--old-file", &path, "--new", "y"], "");
    assert_eq!(out.status.code(), Some(1));
    assert!(assert_withheld(&out, &canary()).contains("error[IO]"));
    let out = s.output(
        &["patch", "x", "--old", "y", "--new-file", &path, "--json"],
        "",
    );
    assert_eq!(out.status.code(), Some(1));
    let json = assert_withheld(&out, &canary());
    assert!(
        json.starts_with(r#"{"ok":false,"error":{"code":"IO","#),
        "{json}"
    );
    assert!(!json.contains("details"), "{json}");
}

/// Renaming a page away from a secret-looking slug does not print the old slug.
#[test]
fn rename_from_a_secret_slug_withholds_it() {
    let s = Session::initialized();
    let bad = canary();
    fs::write(
        s.root.join(format!(".mwf/pages/{bad}.md")),
        "---\ntitle: One\ntype: knowledge\nsummary: one\nstatus: active\ncreated: 2026-11-20T10:00:00Z\nupdated: 2026-11-20T10:00:00Z\n---\nbody\n",
    )
    .unwrap();
    let out = s.output(&["rename", &bad, "clean"], "");
    assert_eq!(out.status.code(), Some(0));
    let text = assert_withheld(&out, &bad);
    assert!(
        text.starts_with("renamed [slug withheld: looks like a secret] -> clean\n"),
        "{text}"
    );
}

/// Output that cannot be written is a failure, `--help` and `--version` included.
#[cfg(target_os = "linux")]
#[test]
fn unwritable_stdout_exits_1() {
    let s = Session::initialized();
    for args in [
        &["--help"][..],
        &["--version"],
        &["new", "--help"],
        &["list"],
        &["--json", "show", "x"],
    ] {
        let full = fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .unwrap();
        let status = std::process::Command::new(assert_cmd::cargo::cargo_bin!("mwf"))
            .args(args)
            .current_dir(&s.root)
            .stdout(full)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(1), "{args:?}");
    }
}
