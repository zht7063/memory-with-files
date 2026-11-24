//! End-to-end tests of `mwf hook` with fake host input (ADRs 0021, 0051): the compiled binary
//! in temporary git roots, fed the JSON Claude Code, Codex and Antigravity send. Transcripts are `insta`
//! snapshots with the per-run fence nonce, the root and timestamps replaced.
//!
//! Only the binary is tested here, as in `cli.rs`: depending on workspace crates, even as
//! dev-dependencies, would add edges that `.github/scripts/check-crate-graph.sh` rejects.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::process::Output;

use assert_cmd::cargo::cargo_bin_cmd;
use tempfile::TempDir;

/// The longest `additionalContext` a hook prints (ADR 0051).
const MAX_CONTEXT_CHARS: usize = 9800;

struct Session {
    _dir: TempDir,
    root: PathBuf,
    transcript: String,
}

impl Session {
    fn new() -> Session {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        Session {
            _dir: dir,
            root,
            transcript: String::new(),
        }
    }

    fn initialized() -> Session {
        let s = Session::new();
        assert!(s.mwf(&["init"], "").status.success());
        s
    }

    fn mwf(&self, args: &[&str], stdin: &str) -> Output {
        cargo_bin_cmd!("mwf")
            .args(args)
            .current_dir(&self.root)
            .write_stdin(stdin)
            .output()
            .unwrap()
    }

    fn new_page(&self, slug: &str, page_type: &str, title: &str, summary: &str, body: &str) {
        let out = self.mwf(
            &[
                "new",
                slug,
                "--type",
                page_type,
                "--title",
                title,
                "--summary",
                summary,
            ],
            body,
        );
        assert!(out.status.success(), "{out:?}");
    }

    /// Runs `mwf hook event --host host` with `input` (with `cwd` set to the root unless it has
    /// one), checks the invariants every hook run keeps, records it and returns stdout.
    fn hook(&mut self, event: &str, host: &str, input: &str) -> String {
        let input = if input.contains("\"cwd\"") || !input.starts_with('{') {
            input.to_owned()
        } else {
            let cwd = format!("{{\"cwd\":{:?},", self.root.display().to_string());
            input.replacen('{', &cwd, 1).replace(",}", "}")
        };
        let out = self.mwf(&["hook", event, "--host", host], &input);
        let stdout = String::from_utf8(out.stdout).unwrap();
        let stderr = String::from_utf8(out.stderr).unwrap();
        assert_eq!(out.status.code(), Some(0), "hooks always exit 0");
        assert!(
            stdout.ends_with('\n') && stdout.lines().count() == 1 && stdout.starts_with('{'),
            "one line of JSON: {stdout:?}"
        );
        check_context(&stdout);
        let t = &mut self.transcript;
        let _ = writeln!(t, "$ mwf hook {event} --host {host}");
        let shown = input.replace(&self.root.display().to_string(), "[ROOT]");
        if shown.len() > 300 {
            let _ = writeln!(t, "< ({} bytes)", shown.len());
        } else {
            let _ = writeln!(t, "< {shown}");
        }
        // Escaped newlines are kept and followed by a real one, so the snapshot reads well.
        t.push_str(&stdout.replace("\\n", "\\n\n    "));
        for line in stderr.lines() {
            let _ = writeln!(t, "[stderr] {line}");
        }
        t.push('\n');
        stdout
    }

    fn snapshot(&self, name: &str) {
        let filters = vec![
            (r"MWF-DATA-[0-9a-f]{24}", "MWF-DATA-[NONCE]"),
            (r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", "[TIME]"),
        ];
        insta::with_settings!({ filters => filters, prepend_module_to_snapshot => false }, {
            insta::assert_snapshot!(name, self.transcript);
        });
    }
}

/// When stdout carries an `additionalContext` (Antigravity: an injected `systemMessage`), it
/// fits the limit and its fence is whole: the nonce on both marker lines, the closing one last,
/// and no other line that looks like one.
fn check_context(stdout: &str) {
    let Some((i, key)) = ["\"additionalContext\":\"", "\"systemMessage\":\""]
        .into_iter()
        .find_map(|k| stdout.rfind(k).map(|i| (i, k)))
    else {
        return;
    };
    let rest = &stdout[i + key.len()..];
    let mut text = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => match chars.next().unwrap() {
                'n' => text.push('\n'),
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    text.push(char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap());
                }
                other => text.push(other),
            },
            c => text.push(c),
        }
    }
    if !text.contains("<<<MWF-DATA-") {
        return; // The Stop reminder is our own text, not data.
    }
    assert!(text.chars().count() <= MAX_CONTEXT_CHARS, "over the limit");
    let close = text.lines().last().unwrap();
    let nonce = close
        .strip_prefix("MWF-DATA-")
        .and_then(|r| r.strip_suffix(">>>"))
        .unwrap_or_else(|| panic!("closing marker missing: {close:?}"));
    assert_eq!(nonce.len(), 24);
    let open = format!("<<<MWF-DATA-{nonce}");
    assert_eq!(text.lines().filter(|l| *l == open).count(), 1);
    assert_eq!(
        text.matches("MWF-DATA-").count(),
        4,
        "two markers, each named in the note"
    );
}

const CLAUDE: &str = "claude";
const CODEX: &str = "codex";
const AGY: &str = "antigravity";
const ALLOW: &str = "{\"decision\":\"allow\"}\n";

#[test]
fn without_mwf_every_hook_is_silent() {
    let mut s = Session::new();
    for host in [CLAUDE, CODEX] {
        for (event, input) in [
            ("session-start", r#"{"session_id":"s","source":"startup"}"#),
            (
                "prompt",
                r#"{"session_id":"s","prompt":"how do we run the tests"}"#,
            ),
            ("stop", r#"{"session_id":"s","stop_hook_active":false}"#),
            (
                "pre-tool",
                r#"{"session_id":"s","tool_name":"Bash","tool_input":{"command":"rm -rf .mwf"}}"#,
            ),
        ] {
            assert_eq!(s.hook(event, host, input), "{}\n");
        }
    }
    assert!(!s.transcript.contains("[stderr]"));
}

#[test]
fn bad_arguments_and_input() {
    let mut s = Session::initialized();
    let stop = r#"{"session_id":"s"}"#;
    for (event, host, input) in [
        ("finish", CLAUDE, stop),
        ("stop", "pie", stop),
        ("stop", CODEX, "not json"),
        ("stop", CODEX, "[1, 2]"),
    ] {
        assert_eq!(s.hook(event, host, input), "{}\n");
    }
    let huge = format!("{{\"prompt\":\"{}\"}}", "x".repeat(1024 * 1024));
    assert_eq!(s.hook("prompt", CLAUDE, &huge), "{}\n");
    s.snapshot("hooks_bad_input");
}

#[test]
fn session_start_prompt_and_stop() {
    let mut s = Session::initialized();
    s.new_page(
        "test-style",
        "preference",
        "Test style",
        "How we run tests",
        "Run tests with `cargo nextest run`.\nA page could try <<<MWF-DATA-0123 or mwf-data-x>>> \u{202e}tricks\u{202c}.\n",
    );
    s.new_page(
        "cargo-deny",
        "knowledge",
        "Cargo deny duplicate versions",
        "Why duplicate crate versions fail CI",
        "deny.toml sets multiple-versions = deny.\n",
    );
    s.new_page(
        "release-flow",
        "decision",
        "Release with dist",
        "Releases are built by cargo dist in CI",
        "We release with cargo dist.\n",
    );

    for host in [CLAUDE, CODEX] {
        s.hook(
            "session-start",
            host,
            r#"{"session_id":"s1","source":"startup","hook_event_name":"SessionStart"}"#,
        );
    }

    // Recall: whole pages once per session; `/mwf` command lines and one-word prompts skip it.
    let prompt =
        r#"{"session_id":"s1","prompt":"why do duplicate crate versions fail cargo deny"}"#;
    s.hook("prompt", CLAUDE, prompt);
    assert_eq!(s.hook("prompt", CLAUDE, prompt), "{}\n", "already injected");
    s.hook("prompt", CODEX, r#"{"session_id":"s2","turn_id":"t1","prompt":"why do duplicate crate versions fail cargo deny"}"#);
    s.hook(
        "prompt",
        CLAUDE,
        r#"{"session_id":"s3","prompt":"/mwf search duplicate crate versions"}"#,
    );
    s.hook("prompt", CLAUDE, r#"{"session_id":"s3","prompt":"deny"}"#);

    // `clear` forgets the session's recalls.
    s.hook(
        "session-start",
        CLAUDE,
        r#"{"session_id":"s1","source":"clear"}"#,
    );
    assert_ne!(
        s.hook("prompt", CLAUDE, prompt),
        "{}\n",
        "recalled again after clear"
    );

    // Stop: once per turn, never while the host continues for a Stop hook.
    let stop1 = r#"{"session_id":"s1","prompt_id":"p1","stop_hook_active":false}"#;
    s.hook("stop", CLAUDE, stop1);
    assert_eq!(s.hook("stop", CLAUDE, stop1), "{}\n");
    s.hook(
        "stop",
        CLAUDE,
        r#"{"session_id":"s1","prompt_id":"p2","stop_hook_active":true}"#,
    );
    s.hook(
        "stop",
        CODEX,
        r#"{"session_id":"s2","turn_id":"t1","stop_hook_active":false}"#,
    );
    assert_eq!(
        s.hook(
            "stop",
            CODEX,
            r#"{"session_id":"s2","turn_id":"t1","stop_hook_active":false}"#
        ),
        "{}\n"
    );
    s.snapshot("hooks_session");
}

#[test]
fn pre_tool_guard() {
    let mut s = Session::initialized();
    fs::create_dir(s.root.join("src")).unwrap();
    std::os::unix::fs::symlink(".mwf/pages", s.root.join("notes")).unwrap();
    let deny = |out: &str| out.contains("\"permissionDecision\":\"deny\"");
    let claude = [
        (
            r#"{"tool_name":"Write","tool_input":{"file_path":".mwf/pages/a.md","content":"x"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"Edit","tool_input":{"file_path":"ROOT/.mwf/index.md"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"Write","tool_input":{"file_path":"notes/new.md"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"MultiEdit","tool_input":{"file_path":"src/.mwf/../main.rs"}}"#,
            false,
        ),
        (
            r#"{"tool_name":"Write","tool_input":{"file_path":"src/main.rs"}}"#,
            false,
        ),
        (
            r#"{"tool_name":"Read","tool_input":{"file_path":".mwf/index.md"}}"#,
            false,
        ),
        (
            r#"{"tool_name":"Bash","tool_input":{"command":"echo x >> .mwf/log.md"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"Bash","tool_input":{"command":"sed -i s/a/b/ .mwf/pages/a.md"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"Bash","tool_input":{"command":"cat .mwf/index.md"}}"#,
            false,
        ),
        (
            r#"{"tool_name":"Bash","tool_input":{"command":"mwf delete a"}}"#,
            false,
        ),
    ];
    let root = s.root.display().to_string();
    for (input, denied) in claude {
        let input = input.replace("ROOT", &root);
        assert_eq!(deny(&s.hook("pre-tool", CLAUDE, &input)), denied, "{input}");
    }
    let codex = [
        (
            r#"{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: src/main.rs\n@@\n-a\n+b\n*** Add File: .mwf/pages/b.md\n+hi\n*** End Patch\n"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Add File: src/b.rs\n+fn b() {}\n*** End Patch\n"}}"#,
            false,
        ),
        (
            r#"{"tool_name":"Bash","tool_input":{"command":"rm -rf .mwf"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"Bash","tool_input":{"command":"mwf show a"}}"#,
            false,
        ),
    ];
    for (input, denied) in codex {
        assert_eq!(deny(&s.hook("pre-tool", CODEX, input)), denied, "{input}");
    }
    s.snapshot("hooks_pre_tool");
}

#[test]
fn budget_keeps_the_closing_fence() {
    let mut s = Session::initialized();
    // A budget far above the host limit: the wrapper caps it at 9800 characters in total.
    fs::write(
        s.root.join(".mwf/config.toml"),
        "[hooks]\nsession_start_max_chars = 100000\nrecall_top_k = 100\nrecall_min_terms = 1\n",
    )
    .unwrap();
    let summary = "Notes about the widget parser and its buffers, ".repeat(3);
    for i in 0..120 {
        s.new_page(
            &format!("widget-{i:03}"),
            "knowledge",
            &format!("Widget parser notes {i}"),
            &summary[..118],
            "The widget parser reads buffers.\n",
        );
    }
    let start = s.hook(
        "session-start",
        CLAUDE,
        r#"{"session_id":"b","source":"startup"}"#,
    );
    assert!(
        start.contains("[mwf: truncated; run `mwf index`"),
        "{start}"
    );
    assert!(
        start.chars().count() > MAX_CONTEXT_CHARS - 500,
        "the budget is used"
    );

    // Recall emits only what fits and records only that: the rest comes with the next prompt.
    let prompt = r#"{"session_id":"b","prompt":"widget parser buffers"}"#;
    let first = s.hook("prompt", CLAUDE, prompt);
    let second = s.hook("prompt", CLAUDE, prompt);
    let shown = |out: &str| -> Vec<String> {
        out.split("\\n- ")
            .skip(1)
            .map(|l| l.split(':').next().unwrap().to_owned())
            .collect()
    };
    let (first, second) = (shown(&first), shown(&second));
    assert!(
        (40..100).contains(&first.len()),
        "{} of 100 fit",
        first.len()
    );
    assert!(
        !second.is_empty() && second.iter().all(|p| !first.contains(p)),
        "no repeats"
    );
    // Had the pages dropped from the first 100 been recorded, only 20 would be left.
    assert!(
        second.len() > 120 - 100,
        "pages dropped for the budget come back"
    );

    // A config error is named, without a path, where memory was not injected.
    fs::write(
        s.root.join(".mwf/config.toml"),
        "[hooks]\nrecall_top_k = \"x\"\n",
    )
    .unwrap();
    let skipped = s.hook(
        "session-start",
        CODEX,
        r#"{"session_id":"b","source":"startup"}"#,
    );
    assert_eq!(
        skipped,
        "{\"systemMessage\":\"mwf: session-start hook skipped (INVALID_CONFIG); run `mwf lint`\"}\n"
    );
    assert_eq!(
        s.hook("stop", CODEX, r#"{"session_id":"b","turn_id":"t"}"#),
        "{}\n"
    );
    assert_eq!(
        s.hook(
            "pre-tool",
            CODEX,
            r#"{"tool_name":"Bash","tool_input":{"command":"rm .mwf/x"}}"#
        ),
        "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"mwf: this command looks like it writes under .mwf/, which only mwf commands may change. Use `mwf new`, `mwf write`, `mwf patch`, `mwf set`, `mwf rename`, `mwf archive` or `mwf delete` instead. If the command only reads .mwf/, run the matching read command (`mwf show`, `mwf search`, `mwf list`, `mwf log`) instead.\"}}\n",
        "the guard needs no config"
    );
}

#[test]
fn failed_state_save_skips_the_prompt_hook_by_code() {
    use std::os::unix::fs::PermissionsExt;
    let mut s = Session::initialized();
    s.new_page(
        "cargo-deny",
        "knowledge",
        "Cargo deny duplicate versions",
        "Why duplicate crate versions fail CI",
        "deny.toml sets multiple-versions = deny.\n",
    );
    // `.state/` can be read (no state yet) but not written: `mark_recalled` fails to save.
    let state = s.root.join(".mwf/.state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o555)).unwrap();
    let writable = fs::write(state.join("probe"), "").is_ok(); // root ignores the mode
    let out = (!writable).then(|| {
        s.hook(
            "prompt",
            CLAUDE,
            r#"{"session_id":"s1","prompt":"why do duplicate crate versions fail cargo deny"}"#,
        )
    });
    fs::set_permissions(&state, fs::Permissions::from_mode(0o755)).unwrap();
    let Some(out) = out else { return };
    assert_eq!(
        out, "{\"systemMessage\":\"mwf: prompt hook skipped (IO); run `mwf lint`\"}\n",
        "no pages without the record, and only the code is shown"
    );
}

/// Antigravity (ADR 0055): its own input and output shapes, recall on the first model call of a
/// prompt only, a reminder only after a clean first run, and a guard that never prints `{}`.
#[test]
fn antigravity_session() {
    let mut s = Session::initialized();
    s.new_page(
        "test-command",
        "knowledge",
        "Running the tests",
        "Use cargo nextest run, not cargo test",
        "Run `cargo nextest run`.\n",
    );
    s.new_page(
        "tabs",
        "preference",
        "Indent with tabs",
        "The user wants tabs in Go files",
        "Use tabs in Go files.\n",
    );
    let common = r#""conversationId":"c1","workspacePaths":["ROOT"],"lastUserInput":"how do we run the tests here""#;
    let root = s.root.display().to_string();
    let agy = |s: &mut Session, event: &str, extra: &str| {
        let input = format!("{{{common},{extra}}}")
            .replace("ROOT", &root)
            .replace(",}", "}");
        s.hook(event, AGY, &input)
    };
    let start = agy(&mut s, "session-start", r#""hookEventName":"SessionStart""#);
    assert!(
        start.starts_with(r#"{"injectSteps":[{"systemMessage":{"systemMessage":""#),
        "{start}"
    );
    assert!(start.contains("Indent with tabs"), "{start}");
    let recall = agy(
        &mut s,
        "prompt",
        r#""hookEventName":"PreInvocation","invocationNum":0"#,
    );
    assert!(recall.contains("test-command"), "{recall}");
    // Later model calls of the same prompt, and the same prompt again: nothing more.
    assert_eq!(agy(&mut s, "prompt", r#""invocationNum":1"#), "{}\n");
    assert_eq!(agy(&mut s, "prompt", r#""invocationNum":0"#), "{}\n");
    let stop = agy(
        &mut s,
        "stop",
        r#""executionNum":0,"terminationReason":"NO_TOOL_CALL","error":"","fullyIdle":true"#,
    );
    assert!(
        stop.starts_with(r#"{"decision":"continue","reason":""#),
        "{stop}"
    );
    for extra in [
        r#""executionNum":1,"terminationReason":"NO_TOOL_CALL","error":"""#,
        r#""executionNum":0,"terminationReason":"ERROR","error":"Error 400""#,
    ] {
        assert_eq!(agy(&mut s, "stop", extra), "{}\n", "{extra}");
    }
    let deny = |out: &str| out.starts_with(r#"{"decision":"deny","reason":"#);
    for (call, denied) in [
        (
            r#""toolCall":{"name":"write_file","args":{"Path":".mwf/pages/x.md","Content":"x"}}"#,
            true,
        ),
        (
            r#""toolCall":{"name":"edit_file","args":{"Path":"ROOT/.mwf/log.md","Target":"a","Replacement":"b"}}"#,
            true,
        ),
        (
            r#""toolCall":{"name":"run_command","args":{"CommandLine":"bash -lc 'rm .mwf/log.md'","toolSummary":"rm"}}"#,
            true,
        ),
        (
            r#""toolCall":{"name":"run_command","args":{"CommandLine":"mwf show tabs","toolSummary":"show"}}"#,
            false,
        ),
        (
            r#""toolCall":{"name":"write_file","args":{"Path":"src/main.rs","Content":"x"}}"#,
            false,
        ),
    ] {
        let out = agy(&mut s, "pre-tool", call);
        assert_eq!(deny(&out), denied, "{call}");
        if !denied {
            assert_eq!(out, ALLOW, "{call}");
        }
    }
    // Bad input and bad arguments still allow the tool: Antigravity blocks it on `{}`.
    assert_eq!(s.hook("pre-tool", AGY, "not json"), ALLOW);
    assert_eq!(s.hook("pre-tool", "agy", r#"{"cwd":"relative"}"#), ALLOW);
    s.snapshot("hooks_antigravity");
}

#[test]
fn antigravity_without_mwf_allows_and_injects_nothing() {
    let mut s = Session::new();
    for (event, input) in [
        ("session-start", r#"{"conversationId":"c"}"#),
        (
            "prompt",
            r#"{"conversationId":"c","invocationNum":0,"lastUserInput":"run the tests"}"#,
        ),
        (
            "stop",
            r#"{"conversationId":"c","executionNum":0,"terminationReason":"NO_TOOL_CALL"}"#,
        ),
    ] {
        assert_eq!(s.hook(event, AGY, input), "{}\n");
    }
    let input = r#"{"toolCall":{"name":"run_command","args":{"CommandLine":"rm -rf .mwf"}}}"#;
    assert_eq!(s.hook("pre-tool", AGY, input), ALLOW);
}

/// pi (ADR 0055): what the bridge extension sends, in Claude's shapes with pi's tool names.
#[test]
fn pi_session() {
    let mut s = Session::initialized();
    s.new_page(
        "test-command",
        "knowledge",
        "Running the tests",
        "Use cargo nextest run, not cargo test",
        "Run `cargo nextest run`.\n",
    );
    let start = s.hook(
        "session-start",
        "pi",
        r#"{"session_id":"p1","source":"startup"}"#,
    );
    assert!(start.contains("\"additionalContext\""), "{start}");
    let recall = s.hook(
        "prompt",
        "pi",
        r#"{"session_id":"p1","prompt":"how do we run the tests here"}"#,
    );
    assert!(recall.contains("test-command"), "{recall}");
    let stop = s.hook(
        "stop",
        "pi",
        r#"{"session_id":"p1","prompt_id":"a.b-1","stop_hook_active":false}"#,
    );
    assert!(stop.contains("\"hookEventName\":\"Stop\""), "{stop}");
    assert_eq!(
        s.hook(
            "stop",
            "pi",
            r#"{"session_id":"p1","prompt_id":"a.b-1","stop_hook_active":false}"#
        ),
        "{}\n"
    );
    let deny = |out: &str| out.contains("\"permissionDecision\":\"deny\"");
    for (input, denied) in [
        (
            r#"{"tool_name":"write","tool_input":{"path":".mwf/pages/x.md","content":"x"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"edit","tool_input":{"path":".mwf/log.md","edits":[{"oldText":"a","newText":"b"}]}}"#,
            true,
        ),
        (
            r#"{"tool_name":"bash","tool_input":{"command":"sh -c 'echo x > .mwf/log.md'"}}"#,
            true,
        ),
        (
            r#"{"tool_name":"bash","tool_input":{"command":"mwf show test-command"}}"#,
            false,
        ),
        (
            r#"{"tool_name":"write","tool_input":{"path":"src/main.rs","content":"x"}}"#,
            false,
        ),
    ] {
        assert_eq!(deny(&s.hook("pre-tool", "pi", input)), denied, "{input}");
    }
    // pi drops a leading `@`, expands `~/` and reads `file://` URLs before it writes.
    let url = format!("file://{}/.mwf/x.md", s.root.display());
    for path in ["@.mwf/log.md", url.as_str()] {
        let input = format!(r#"{{"tool_name":"write","tool_input":{{"path":{path:?}}}}}"#);
        assert!(deny(&s.hook("pre-tool", "pi", &input)), "{path}");
    }
    s.snapshot("hooks_pi");
    let home = s.root.parent().unwrap();
    let name = s.root.file_name().unwrap().to_str().unwrap();
    let input = format!(
        r#"{{"cwd":{:?},"tool_name":"write","tool_input":{{"path":"~/{name}/.mwf/log.md"}}}}"#,
        s.root.display().to_string()
    );
    let out = cargo_bin_cmd!("mwf")
        .args(["hook", "pre-tool", "--host", "pi"])
        .current_dir(&s.root)
        .env("HOME", home)
        .write_stdin(input)
        .output()
        .unwrap();
    assert!(deny(&String::from_utf8(out.stdout).unwrap()), "~/ is HOME");
}
