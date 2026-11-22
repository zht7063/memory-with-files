//! `run_with` against temporary home directories.

use std::collections::BTreeMap;

use super::*;

struct Home {
    _dir: tempfile::TempDir,
    root: PathBuf,
    env: Env,
}

impl Home {
    fn new() -> Home {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("bin")).unwrap();
        fs::write(root.join("bin/mwf"), "").unwrap();
        let env = Env {
            home: Some(root.clone().into()),
            claude_config_dir: None,
            codex_home: None,
            path: Some(root.join("bin").into()),
            exe: Ok(root.join("bin/mwf")),
        };
        Home {
            _dir: dir,
            root,
            env,
        }
    }

    /// Exit code, stdout, stderr.
    fn run(&self, args: &[&str]) -> (u8, String, String) {
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_with(
            &args,
            &mut Io {
                stdin: &mut io::empty(),
                stdout: &mut out,
                stderr: &mut err,
            },
            &self.env,
        );
        let code = if code == ExitCode::SUCCESS {
            0
        } else if code == ExitCode::from(1) {
            1
        } else {
            assert_eq!(code, ExitCode::from(2));
            2
        };
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    fn ok(&self, args: &[&str]) -> String {
        let (code, out, err) = self.run(args);
        assert_eq!(code, 0, "{out}{err}");
        out
    }

    /// Every file under the home directory except `bin/`, with its contents.
    fn tree(&self) -> BTreeMap<String, String> {
        fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
            for e in fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                let rel = p.strip_prefix(root).unwrap().display().to_string();
                if rel == "bin" {
                    continue;
                }
                let meta = fs::symlink_metadata(&p).unwrap();
                if meta.is_dir() {
                    out.insert(format!("{rel}/"), String::new());
                    walk(&p, root, out);
                } else {
                    out.insert(rel, fs::read_to_string(&p).unwrap_or_default());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.root, &self.root, &mut out);
        out
    }
}

#[test]
fn install_writes_hooks_and_skill_and_is_idempotent() {
    let h = Home::new();
    fs::create_dir(h.root.join(".claude")).unwrap();
    let out = h.ok(&["install", "--host", "claude"]);
    assert!(out.starts_with("installed mwf for Claude Code\n"), "{out}");
    assert!(out.contains("hook command: mwf\n"), "{out}");
    let settings = fs::read_to_string(h.root.join(".claude/settings.json")).unwrap();
    for event in ["session-start", "prompt", "stop", "pre-tool"] {
        assert!(settings.contains(&format!("\"mwf hook {event} --host claude\"")));
    }
    assert_eq!(
        fs::read_to_string(h.root.join(".claude/skills/mwf/SKILL.md")).unwrap(),
        mwf_assets::SKILL_MD
    );
    let before = h.tree();
    let again = h.ok(&["install", "--host", "claude"]);
    assert!(
        !again.contains("added") && !again.contains("created"),
        "{again}"
    );
    assert_eq!(h.tree(), before);
}

#[test]
fn uninstall_restores_the_previous_files() {
    let h = Home::new();
    fs::create_dir(h.root.join(".codex")).unwrap();
    // The user's own layout: what mwf does not touch keeps it (the inline Notification
    // array), and what it touches and restores is in the hosts' own layout.
    let user = concat!(
        "{\n",
        "    \"hooks\": {\n",
        "        \"Notification\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"say hi\"}]}],\n",
        "        \"Stop\": [\n",
        "            {\n",
        "                \"hooks\": [\n",
        "                    {\n",
        "                        \"type\": \"command\",\n",
        "                        \"command\": \"say done\"\n",
        "                    }\n",
        "                ]\n",
        "            }\n",
        "        ]\n",
        "    },\n",
        "    \"description\": \"mine\"\n",
        "}\n"
    );
    fs::write(h.root.join(".codex/hooks.json"), user).unwrap();
    let before = h.tree();
    h.ok(&["install", "--host", "codex"]);
    let out = h.ok(&["uninstall", "--host", "codex"]);
    assert!(out.contains("Stop: removed"), "{out}");
    let mut after = h.tree();
    // The hooks file was backed up twice (install and uninstall changed it); nothing else stays.
    let backups: Vec<_> = after
        .keys()
        .filter(|k| k.contains(".mwf-bak-"))
        .cloned()
        .collect();
    assert_eq!(backups.len(), 2, "{after:?}");
    for b in &backups {
        after.remove(b);
    }
    // The skill directory's parents (~/.agents/skills) are not mwf's to remove.
    after.remove(".agents/");
    after.remove(".agents/skills/");
    assert_eq!(after, before);
    assert_eq!(
        fs::read_to_string(h.root.join(".codex/hooks.json")).unwrap(),
        user
    );
}

#[test]
fn install_then_uninstall_on_a_fresh_home_leaves_nothing_but_directories() {
    let h = Home::new();
    h.ok(&["install", "--host", "claude"]);
    h.ok(&["uninstall", "--host", "claude"]);
    let tree: Vec<_> = h.tree().into_keys().collect();
    assert_eq!(tree, [".claude/", ".claude/skills/"]);
}

#[test]
fn dry_run_writes_nothing() {
    let h = Home::new();
    let out = h.ok(&["install", "--host", "codex", "--dry-run"]);
    assert!(
        out.starts_with("would install mwf for Codex (dry run"),
        "{out}"
    );
    assert!(out.contains("SessionStart: added"), "{out}");
    assert!(h.tree().is_empty());
    h.ok(&["install", "--host", "codex"]);
    let before = h.tree();
    let out = h.ok(&["uninstall", "--host", "codex", "--dry-run"]);
    assert!(out.contains("SKILL.md: removed"), "{out}");
    assert_eq!(h.tree(), before);
}

#[test]
fn environment_directories_are_honoured() {
    let mut h = Home::new();
    let claude = h.root.join("cc");
    let codex = h.root.join("cx");
    fs::create_dir(&claude).unwrap();
    fs::create_dir(&codex).unwrap();
    h.env.claude_config_dir = Some(claude.clone().into());
    h.env.codex_home = Some(codex.clone().into());
    h.ok(&["install", "--host", "claude"]);
    h.ok(&["install", "--host", "codex"]);
    assert!(claude.join("settings.json").is_file());
    assert!(claude.join("skills/mwf/SKILL.md").is_file());
    assert!(codex.join("hooks.json").is_file());
    // Codex reads user skills from ~/.agents/skills, whatever CODEX_HOME says.
    assert!(h.root.join(".agents/skills/mwf/SKILL.md").is_file());
    assert!(!codex.join("skills").exists());

    h.env.codex_home = Some("relative".into());
    let (code, _, err) = h.run(&["install", "--host", "codex"]);
    assert_eq!(
        (code, err.as_str()),
        (
            1,
            "error[INVALID_ENV]: CODEX_HOME must be an absolute path\n"
        )
    );
    h.env.codex_home = Some(h.root.join("missing").into());
    let (code, _, err) = h.run(&["install", "--host", "codex"]);
    assert_eq!(code, 1);
    assert!(err.starts_with("error[INVALID_ENV]: CODEX_HOME ("), "{err}");
    h.env.home = None;
    let (_, _, err) = h.run(&["uninstall", "--host", "claude"]);
    assert!(err.is_empty(), "CLAUDE_CONFIG_DIR is enough: {err}");
    h.env.claude_config_dir = None;
    let (code, _, err) = h.run(&["uninstall", "--host", "claude"]);
    assert_eq!(
        (code, err.as_str()),
        (1, "error[INVALID_ENV]: HOME is not set\n")
    );
}

#[test]
fn hook_command_is_the_binary_path_unless_path_finds_it() {
    let mut h = Home::new();
    fs::create_dir(h.root.join("other")).unwrap();
    fs::write(h.root.join("other/mwf"), "").unwrap();
    // Not on PATH.
    fs::create_dir(h.root.join("empty")).unwrap();
    h.env.path = Some(h.root.join("empty").into());
    let out = h.ok(&["install", "--host", "claude", "--dry-run"]);
    let exe = h.root.join("bin/mwf").display().to_string();
    assert!(out.contains(&format!("hook command: {exe}\n")), "{out}");
    assert!(out.contains("note: mwf is not on PATH"), "{out}");
    // Another mwf comes first on PATH.
    h.env.path = Some(std::env::join_paths([h.root.join("other"), h.root.join("bin")]).unwrap());
    let out = h.ok(&["install", "--host", "claude", "--dry-run"]);
    assert!(out.contains(&format!("hook command: {exe}\n")), "{out}");
    assert!(out.contains("is another binary"), "{out}");
    // A path with a space is quoted for the shell, and recognised as mwf's on uninstall.
    let spaced = h.root.join("my bin");
    fs::create_dir(&spaced).unwrap();
    fs::write(spaced.join("mwf"), "").unwrap();
    h.env.exe = Ok(spaced.join("mwf"));
    h.env.path = None;
    h.ok(&["install", "--host", "claude"]);
    let settings = fs::read_to_string(h.root.join(".claude/settings.json")).unwrap();
    assert!(
        settings.contains(&format!(
            "\"'{}' hook stop --host claude\"",
            spaced.join("mwf").display()
        )),
        "{settings}"
    );
    h.ok(&["uninstall", "--host", "claude"]);
    assert!(!h.root.join(".claude/settings.json").exists());
}

#[test]
fn edited_skill_files_are_backed_up() {
    let h = Home::new();
    h.ok(&["install", "--host", "claude"]);
    let skill = h.root.join(".claude/skills/mwf");
    fs::write(skill.join("SKILL.md"), "mine\n").unwrap();
    fs::write(skill.join("notes.txt"), "keep\n").unwrap();
    let out = h.ok(&["install", "--host", "claude"]);
    assert!(out.contains("SKILL.md: updated (backup: "), "{out}");
    let out = h.ok(&["uninstall", "--host", "claude"]);
    assert!(out.contains("SKILL.md: removed\n"), "{out}");
    assert!(out.contains("note: kept "), "{out}");
    let mut left: Vec<_> = fs::read_dir(&skill)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(left[0].starts_with("SKILL.md.mwf-bak-"));
    assert_eq!(left[1], "notes.txt");
    assert_eq!(fs::read_to_string(skill.join(&left[0])).unwrap(), "mine\n");
}

#[test]
fn bad_hooks_documents_change_nothing() {
    let h = Home::new();
    fs::create_dir(h.root.join(".claude")).unwrap();
    for text in ["{\"hooks\": [],}", "{\"hooks\": []}", "\u{feff}{}", "[1]"] {
        fs::write(h.root.join(".claude/settings.json"), text).unwrap();
        let (code, out, err) = h.run(&["install", "--host", "claude", "--json"]);
        assert_eq!(code, 1);
        assert!(err.is_empty());
        assert!(
            out.starts_with(
                "{\"ok\":false,\"error\":{\"code\":\"HOST_CONFIG_INVALID\",\"message\":"
            ),
            "{out}"
        );
        assert!(out.contains("nothing was changed"), "{out}");
        assert_eq!(
            fs::read_to_string(h.root.join(".claude/settings.json")).unwrap(),
            text
        );
        // The skill is planned too, but nothing is written before every check passed.
        assert!(!h.root.join(".claude/skills").exists());
    }
}

#[cfg(unix)]
#[test]
fn links_below_the_base_are_refused_and_a_linked_home_is_fine() {
    use std::os::unix::fs::symlink;
    let mut h = Home::new();
    let elsewhere = h.root.join("dotfiles");
    fs::create_dir(&elsewhere).unwrap();
    symlink(&elsewhere, h.root.join(".claude")).unwrap();
    let (code, _, err) = h.run(&["install", "--host", "claude"]);
    assert_eq!(code, 1);
    assert!(err.starts_with("error[WRONG_FILE_TYPE]: "), "{err}");
    assert!(err.contains(".claude is a symbolic link"), "{err}");
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    fs::remove_file(h.root.join(".claude")).unwrap();

    // $HOME itself may be a link.
    let link = h.root.join("home-link");
    let real = h.root.join("real-home");
    fs::create_dir(&real).unwrap();
    symlink(&real, &link).unwrap();
    h.env.home = Some(link.into());
    h.ok(&["install", "--host", "codex"]);
    assert!(real.join(".codex/hooks.json").is_file());
    assert!(real.join(".agents/skills/mwf/SKILL.md").is_file());
}

#[test]
fn json_output() {
    let h = Home::new();
    let out = h.ok(&["install", "--host", "codex", "--json"]);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(out.starts_with("{\"ok\":true,\"data\":{\"action\":\"install\",\"host\":\"codex\",\"dry_run\":false,\"command\":\"mwf\",\"hooks\":{"), "{out}");
    assert_eq!(v["data"]["hooks"]["status"], "created");
    assert_eq!(v["data"]["hooks"]["events"]["PreToolUse"], "added");
    assert_eq!(
        v["data"]["skill"]["files"][1]["path"],
        "references/commands.md"
    );
    assert!(out.ends_with("}\n") && out.lines().count() == 1);
    let out = h.ok(&["uninstall", "--json", "--host=codex"]);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v["data"].get("command").is_none());
    assert_eq!(v["data"]["hooks"]["status"], "removed");
}

#[test]
fn usage_errors_exit_2_without_echoing_values() {
    let h = Home::new();
    for (args, why) in [
        (
            &["install"][..],
            "the following required arguments were not provided: --host <HOST>",
        ),
        (
            &["install", "--host", "sk-secret-value"][..],
            "invalid value for '--host <HOST>'",
        ),
        (&["install", "--host"][..], "a value is required"),
        (
            &["install", "--host", "claude", "--host", "codex"][..],
            "the argument '--host <HOST>' cannot be used multiple times",
        ),
        (
            &["uninstall", "--host", "claude", "--force-sk-secret"][..],
            "unexpected option",
        ),
        (
            &["uninstall", "--host", "claude", "sk-secret"][..],
            "unexpected argument",
        ),
    ] {
        let (code, out, err) = h.run(args);
        assert_eq!(code, 2, "{args:?}");
        assert!(out.is_empty());
        assert!(err.starts_with(&format!("error: {why}")), "{args:?}: {err}");
        assert!(
            err.contains(&format!("Usage: mwf {} --host <HOST>", args[0])),
            "{err}"
        );
        assert!(!err.contains("secret"), "{err}");
        let mut with_json = args.to_vec();
        with_json.insert(1, "--json");
        let (code, out, err) = h.run(&with_json);
        assert_eq!(code, 2);
        assert!(err.is_empty());
        assert!(
            out.starts_with(&format!(
                "{{\"ok\":false,\"error\":{{\"code\":\"USAGE\",\"message\":\"{why}"
            )),
            "{out}"
        );
    }
    let (code, out, _) = h.run(&["uninstall", "--bogus", "--help"]);
    assert_eq!(code, 0);
    assert!(out.starts_with("Remove mwf's hooks"), "{out}");
    assert!(h.tree().is_empty());
}

#[test]
fn unwritable_stdout_exits_1() {
    struct Full;
    impl Write for Full {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("full"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let h = Home::new();
    let code = run_with(
        &["install".into(), "--help".into()],
        &mut Io {
            stdin: &mut io::empty(),
            stdout: &mut Full,
            stderr: &mut io::sink(),
        },
        &h.env,
    );
    assert_eq!(code, ExitCode::from(1));
}

#[test]
fn a_relative_path_entry_before_mwf_means_the_binary_path() {
    let mut h = Home::new();
    let exe = h.root.join("bin/mwf").display().to_string();
    let bin = h.root.join("bin").display().to_string();
    // `.`, `bin` and an empty entry (the current directory) before the real mwf could each
    // find another mwf depending on where the host runs the hook.
    for path in [
        format!(".:{bin}"),
        format!("tools:{bin}"),
        format!(":{bin}"),
        format!("{bin}:"),
    ] {
        h.env.path = Some(path.clone().into());
        let out = h.ok(&["install", "--host", "codex", "--dry-run"]);
        let shadowed = !path.starts_with(&bin);
        assert_eq!(
            out.contains(&format!("hook command: {exe}\n")),
            shadowed,
            "{path}: {out}"
        );
        assert_eq!(
            out.contains("PATH has a relative directory"),
            shadowed,
            "{path}: {out}"
        );
        if !shadowed {
            // A relative entry after the match cannot shadow it.
            assert!(out.contains("hook command: mwf\n"), "{path}: {out}");
        }
    }
}

#[test]
fn install_refuses_a_binary_not_named_mwf() {
    let mut h = Home::new();
    fs::write(h.root.join("bin/mwf-dev"), "").unwrap();
    h.env.exe = Ok(h.root.join("bin/mwf-dev"));
    let (code, out, err) = h.run(&["install", "--host", "claude", "--json"]);
    assert_eq!(code, 1);
    assert!(err.is_empty());
    assert!(
        out.starts_with("{\"ok\":false,\"error\":{\"code\":\"INVALID_EXECUTABLE\",\"message\":"),
        "{out}"
    );
    assert!(out.contains("bin/mwf-dev"), "{out}");
    assert!(h.tree().is_empty());
    // Uninstall does not need the binary's name: it works from any binary.
    h.ok(&["uninstall", "--host", "claude"]);
}

#[test]
fn a_blank_hooks_file_is_not_json_but_an_empty_one_is_an_empty_document() {
    let h = Home::new();
    fs::create_dir(h.root.join(".claude")).unwrap();
    for blank in [" ", "\n", "\t\r\n"] {
        fs::write(h.root.join(".claude/settings.json"), blank).unwrap();
        let (code, _, err) = h.run(&["install", "--host", "claude"]);
        assert_eq!(code, 1, "{blank:?}");
        assert!(err.starts_with("error[HOST_CONFIG_INVALID]: "), "{err}");
        assert!(err.contains("expected a JSON value"), "{err}");
        assert_eq!(
            fs::read_to_string(h.root.join(".claude/settings.json")).unwrap(),
            blank
        );
    }
    fs::write(h.root.join(".claude/settings.json"), "").unwrap();
    let out = h.ok(&["install", "--host", "claude"]);
    assert!(out.contains("settings.json: updated"), "{out}");
}

#[test]
fn json_may_come_before_the_command() {
    let h = Home::new();
    let (code, out, _) = h.run(&["--json", "install", "--host", "codex", "--dry-run"]);
    assert_eq!(code, 0);
    assert!(
        out.starts_with("{\"ok\":true,\"data\":{\"action\":\"install\""),
        "{out}"
    );
    let (code, out, _) = h.run(&["--json", "uninstall", "--host"]);
    assert_eq!(code, 2);
    assert!(out.contains("Usage: mwf uninstall"), "{out}");
}

#[test]
fn the_codex_trust_note_follows_what_changes() {
    let h = Home::new();
    let trust = "note: Codex runs new or changed hooks only after you trust them: ";
    let out = h.ok(&["install", "--host", "codex", "--dry-run"]);
    assert!(
        out.contains(&format!("{trust}after a real install, run /hooks")),
        "{out}"
    );
    let out = h.ok(&["install", "--host", "codex"]);
    assert!(
        out.contains(&format!("{trust}run /hooks in Codex")),
        "{out}"
    );
    // Nothing changed: the hooks stay trusted, so no note.
    let out = h.ok(&["install", "--host", "codex"]);
    assert!(!out.contains("run /hooks"), "{out}");
    let out = h.ok(&["install", "--host", "codex", "--dry-run"]);
    assert!(!out.contains("run /hooks"), "{out}");
}
