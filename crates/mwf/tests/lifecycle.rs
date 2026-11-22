//! End-to-end tests of `mwf install` / `mwf uninstall` (ADRs 0037, 0052): the compiled binary
//! with `HOME` (and `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) pointing at temporary directories.
//! Transcripts, including the host files after each step, are `insta` snapshots with the home
//! directory, the binary's directory and backup times replaced.
//!
//! Only the binary is tested here, as in `cli.rs`: depending on workspace crates, even as
//! dev-dependencies, would add edges that `.github/scripts/check-crate-graph.sh` rejects.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;

use assert_cmd::Command;
use tempfile::TempDir;

/// The compiled binary, and the directory holding it (put on `PATH` to make it "the" mwf).
fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mwf"))
}

struct Home {
    _dir: TempDir,
    root: PathBuf,
    /// `PATH` for the binary: its own directory unless a test says otherwise.
    path: String,
    vars: Vec<(&'static str, PathBuf)>,
    transcript: String,
}

impl Home {
    fn new() -> Home {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        Home {
            _dir: dir,
            root,
            path: exe().parent().unwrap().display().to_string(),
            vars: Vec::new(),
            transcript: String::new(),
        }
    }

    fn output(&self, args: &[&str]) -> Output {
        let mut cmd = Command::new(exe());
        cmd.args(args)
            .current_dir(&self.root)
            .env("HOME", &self.root)
            .env("PATH", &self.path)
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("CODEX_HOME");
        for (k, v) in &self.vars {
            cmd.env(k, v);
        }
        cmd.output().unwrap()
    }

    /// Runs `mwf args`, records it and returns stdout.
    fn run(&mut self, args: &[&str]) -> String {
        let out = self.output(args);
        let stdout = String::from_utf8(out.stdout).unwrap();
        let stderr = String::from_utf8(out.stderr).unwrap();
        let t = &mut self.transcript;
        let _ = writeln!(t, "$ mwf {}", args.join(" "));
        t.push_str(&stdout);
        for line in stderr.lines() {
            let _ = writeln!(t, "[stderr] {line}");
        }
        let _ = writeln!(t, "[exit {}]\n", out.status.code().unwrap());
        stdout
    }

    /// Records the contents of `rel` (or that it does not exist).
    fn show(&mut self, rel: &str) {
        let text = fs::read_to_string(self.root.join(rel));
        let t = &mut self.transcript;
        match text {
            Ok(text) => {
                let _ = writeln!(t, "--- ~/{rel}");
                t.push_str(&text);
                if !text.ends_with('\n') {
                    t.push_str("\n[no final newline]\n");
                }
                t.push('\n');
            }
            Err(_) => {
                let _ = writeln!(t, "--- ~/{rel}: absent\n");
            }
        }
    }

    /// Every path under the home directory, `/` after directories.
    fn tree(&self) -> Vec<String> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
            let mut entries: Vec<_> = fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            entries.sort();
            for p in entries {
                let rel = p.strip_prefix(root).unwrap().display().to_string();
                if fs::symlink_metadata(&p).unwrap().is_dir() {
                    out.push(format!("{rel}/"));
                    walk(&p, root, out);
                } else {
                    out.push(rel);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &self.root, &mut out);
        out
    }

    fn snapshot(&self, name: &str) {
        let bin = exe().parent().unwrap().display().to_string();
        let filters = [
            (regex_escape(&self.root.display().to_string()), "[HOME]"),
            (regex_escape(&bin), "[BIN]"),
            (r"\.mwf-bak-\d+(-\d+)?".to_owned(), ".mwf-bak-[TIME]"),
        ];
        let filters: Vec<(&str, &str)> = filters.iter().map(|(a, b)| (a.as_str(), *b)).collect();
        insta::with_settings!({ filters => filters, prepend_module_to_snapshot => false }, {
            insta::assert_snapshot!(name, self.transcript);
        });
    }
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

/// A Claude Code settings file with the user's own settings and a hook of their own.
const CLAUDE_SETTINGS: &str = r#"{
  "model": "opus",
  "permissions": {"allow": ["Bash(npm test)"]},
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "say done"
          }
        ]
      }
    ]
  }
}
"#;

#[test]
fn claude_session() {
    let mut h = Home::new();
    fs::create_dir(h.root.join(".claude")).unwrap();
    fs::write(h.root.join(".claude/settings.json"), CLAUDE_SETTINGS).unwrap();
    h.run(&["install", "--host", "claude", "--dry-run"]);
    h.show(".claude/settings.json");
    h.run(&["install", "--host", "claude"]);
    h.show(".claude/settings.json");
    let installed = h.tree();
    h.run(&["install", "--host", "claude"]);
    assert_eq!(h.tree(), installed, "a second install changes nothing");
    h.run(&["uninstall", "--host", "claude"]);
    h.show(".claude/settings.json");
    h.run(&["uninstall", "--host", "claude"]);
    h.snapshot("lifecycle_claude");

    assert_eq!(
        fs::read_to_string(h.root.join(".claude/settings.json")).unwrap(),
        CLAUDE_SETTINGS,
        "uninstall gives back the user's file"
    );
    let left: Vec<_> = h
        .tree()
        .into_iter()
        .filter(|p| !p.contains(".mwf-bak-"))
        .collect();
    assert_eq!(
        left,
        [".claude/", ".claude/settings.json", ".claude/skills/"]
    );
}

#[test]
fn codex_json_session() {
    let mut h = Home::new();
    let codex = h.root.join("codex-home");
    fs::create_dir(&codex).unwrap();
    h.vars.push(("CODEX_HOME", codex));
    // Not on PATH: the hooks run the binary by its path.
    h.path = String::new();
    h.run(&["install", "--host", "codex", "--json"]);
    h.show("codex-home/hooks.json");
    h.run(&["install", "--json", "--host=codex"]);
    h.run(&["uninstall", "--host", "codex", "--json"]);
    h.show("codex-home/hooks.json");
    h.snapshot("lifecycle_codex_json");
    // Nothing of the user's existed, so nothing is left but directories.
    assert_eq!(h.tree(), [".agents/", ".agents/skills/", "codex-home/"]);
}

#[test]
fn installed_hooks_run() {
    let h = Home::new();
    let out = h.output(&["install", "--host", "codex"]);
    assert!(out.status.success(), "{out:?}");
    let doc = fs::read_to_string(h.root.join(".codex/hooks.json")).unwrap();
    // The command the host would run is `mwf hook <event> --host codex`; run it like the host.
    for event in ["session-start", "prompt", "stop", "pre-tool"] {
        let line = format!("\"command\": \"mwf hook {event} --host codex\"");
        assert!(doc.contains(&line), "{doc}");
        let out = h.output(&["hook", event, "--host", "codex"]);
        assert!(out.status.success());
        assert_eq!(out.stdout, b"{}\n", "no .mwf/ here");
    }
}

#[test]
fn errors() {
    let mut h = Home::new();
    h.run(&["install"]);
    h.run(&["install", "--host", "pi", "--json"]);
    h.run(&["uninstall", "--host", "claude", "--force"]);
    h.run(&["uninstall", "--help"]);
    fs::create_dir(h.root.join(".claude")).unwrap();
    fs::write(
        h.root.join(".claude/settings.json"),
        "{\n  \"hooks\": {},\n}\n",
    )
    .unwrap();
    h.run(&["install", "--host", "claude"]);
    h.run(&["install", "--host", "claude", "--json"]);
    fs::write(
        h.root.join(".claude/settings.json"),
        "{\"hooks\": {\"Stop\": {}}}\n",
    )
    .unwrap();
    h.run(&["uninstall", "--host", "claude"]);
    #[cfg(unix)]
    {
        fs::create_dir(h.root.join("dotfiles")).unwrap();
        std::os::unix::fs::symlink(h.root.join("dotfiles"), h.root.join(".codex")).unwrap();
        h.run(&["install", "--host", "codex"]);
        assert_eq!(fs::read_dir(h.root.join("dotfiles")).unwrap().count(), 0);
    }
    h.vars
        .push(("CLAUDE_CONFIG_DIR", PathBuf::from("relative/dir")));
    h.run(&["install", "--host", "claude"]);
    h.snapshot("lifecycle_errors");
    // Nothing was written by any of them.
    assert_eq!(
        fs::read_to_string(h.root.join(".claude/settings.json")).unwrap(),
        "{\"hooks\": {\"Stop\": {}}}\n"
    );
    assert!(!h.root.join(".claude/skills").exists());
}
