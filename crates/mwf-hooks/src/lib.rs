//! Hook adapter: `mwf hook session-start|prompt|stop|pre-tool --host claude|codex`.
//!
//! See [docs/crates/adapters.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/adapters.md)
//! and ADR 0051. Every run exits 0 and prints exactly one line of JSON: whatever goes wrong,
//! the host's session carries on (ADR 0030).

mod fence;
mod guard;

use std::ffi::OsString;
use std::io::{Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use mwf_app::{App, AppError, ErrorCode};
use serde_json::{Map, Value, json};

use fence::Fence;

/// The most a hook reads from stdin, as the CLI (ADR 0051), in bytes.
pub const STDIN_MAX_BYTES: u64 = 1024 * 1024;

/// The internal deadline from process start; optional work after it is skipped (ADR 0051).
const DEADLINE: Duration = Duration::from_secs(3);

/// The standard streams of one run; tests can pass buffers.
pub struct Io<'a> {
    pub stdin: &'a mut dyn Read,
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Host {
    Claude,
    Codex,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Event {
    SessionStart,
    Prompt,
    Stop,
    PreTool,
}

impl Event {
    fn name(self) -> &'static str {
        match self {
            Event::SessionStart => "session-start",
            Event::Prompt => "prompt",
            Event::Stop => "stop",
            Event::PreTool => "pre-tool",
        }
    }
}

/// Runs one hook. `args` are the arguments after `hook` (`["session-start", "--host",
/// "claude"]`); the host's JSON comes on stdin. Always [`ExitCode::SUCCESS`]: bad arguments or
/// input print `{}` and one `mwf hook: …` line on stderr (ADR 0051).
pub fn run(args: Vec<OsString>, io: &mut Io) -> ExitCode {
    let deadline = Instant::now() + DEADLINE;
    run_with(args, io, &|| Instant::now() >= deadline)
}

/// [`run`] with `late` saying whether the deadline has passed; tests pass their own.
fn run_with(args: Vec<OsString>, io: &mut Io, late: &dyn Fn() -> bool) -> ExitCode {
    let stdin = &mut *io.stdin;
    let out = match panic::catch_unwind(AssertUnwindSafe(|| handle(&args, stdin, late))) {
        Ok(Ok(out)) => out,
        Ok(Err(why)) => {
            let _ = writeln!(io.stderr, "mwf hook: {why}");
            empty()
        }
        Err(_) => {
            let _ = writeln!(io.stderr, "mwf hook: internal error");
            empty()
        }
    };
    let _ = writeln!(io.stdout, "{out}");
    let _ = io.stdout.flush();
    ExitCode::SUCCESS
}

fn empty() -> Value {
    Value::Object(Map::new())
}

/// The output of one run; `Err` is bad arguments or input, for stderr.
fn handle(
    args: &[OsString],
    stdin: &mut dyn Read,
    late: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let (event, host) = parse_args(args)?;
    let input = read_input(stdin)?;
    let cwd = input
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::current_dir().ok())
        .ok_or("no working directory")?;
    let hook = Hook {
        host,
        input: &input,
        cwd: &cwd,
        late,
    };
    if hook.late() {
        return Ok(empty());
    }
    let app = match App::open(&cwd) {
        Ok(app) => app,
        Err(e) if e.code == ErrorCode::NotInitialized => return Ok(empty()),
        Err(e) => return Ok(failed(event, &e)),
    };
    let out = match event {
        Event::SessionStart => hook.session_start(&app),
        Event::Prompt => hook.prompt(&app),
        Event::Stop => hook.stop(&app),
        Event::PreTool => Ok(hook.pre_tool(&app)),
    };
    Ok(out.unwrap_or_else(|e| failed(event, &e)))
}

/// What an app error shows (ADR 0051): a `systemMessage` with the code only (a path could hold
/// a secret-looking slug) where memory was not injected, nothing for Stop and PreToolUse (the
/// guard lets the tool run).
fn failed(event: Event, e: &AppError) -> Value {
    match event {
        Event::SessionStart | Event::Prompt => json!({
            "systemMessage": format!(
                "mwf: {} hook skipped ({}); run `mwf lint`",
                event.name(),
                e.code.as_str()
            )
        }),
        Event::Stop | Event::PreTool => empty(),
    }
}

fn parse_args(args: &[OsString]) -> Result<(Event, Host), String> {
    let mut event = None;
    let mut host = None;
    let mut it = args.iter().map(|a| a.to_string_lossy());
    while let Some(arg) = it.next() {
        let value = if arg == "--host" {
            Some(it.next().ok_or("--host needs a value")?.into_owned())
        } else {
            arg.strip_prefix("--host=").map(str::to_owned)
        };
        if let Some(value) = value {
            let h = match value.as_str() {
                "claude" => Host::Claude,
                "codex" => Host::Codex,
                other => return Err(format!("unknown host {other:?}; use claude or codex")),
            };
            if host.replace(h).is_some() {
                return Err("--host given twice".to_owned());
            }
            continue;
        }
        let e = match arg.as_ref() {
            "session-start" => Event::SessionStart,
            "prompt" => Event::Prompt,
            "stop" => Event::Stop,
            "pre-tool" => Event::PreTool,
            other if other.starts_with('-') => return Err(format!("unknown option {other:?}")),
            other => {
                return Err(format!(
                    "unknown event {other:?}; use session-start, prompt, stop or pre-tool"
                ));
            }
        };
        if event.replace(e).is_some() {
            return Err("more than one event".to_owned());
        }
    }
    match (event, host) {
        (Some(e), Some(h)) => Ok((e, h)),
        (None, _) => Err("missing event: session-start, prompt, stop or pre-tool".to_owned()),
        (_, None) => Err("missing --host claude|codex".to_owned()),
    }
}

/// The host's JSON object from stdin, at most [`STDIN_MAX_BYTES`].
fn read_input(stdin: &mut dyn Read) -> Result<Value, String> {
    let mut bytes = Vec::new();
    stdin
        .take(STDIN_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read stdin: {e}"))?;
    if bytes.len() as u64 > STDIN_MAX_BYTES {
        return Err("stdin is larger than 1 MiB".to_owned());
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err("stdin is not a JSON object".to_owned()),
        Err(e) => Err(format!("stdin is not JSON: {e}")),
    }
}

/// Whether the prompt is a `/mwf` command line the user typed (`^\s*/mwf([\s:-]|$)`): the
/// skill runs `mwf` itself, so recalled pages would repeat it.
fn is_mwf_command(prompt: &str) -> bool {
    prompt
        .trim_start()
        .strip_prefix("/mwf")
        .is_some_and(|rest| {
            rest.chars()
                .next()
                .is_none_or(|c| c.is_whitespace() || c == ':' || c == '-')
        })
}

/// One hook invocation's input.
struct Hook<'a> {
    host: Host,
    input: &'a Value,
    cwd: &'a Path,
    /// Whether the deadline has passed; asked before each optional step.
    late: &'a dyn Fn() -> bool,
}

impl Hook<'_> {
    fn str(&self, key: &str) -> &str {
        self.input.get(key).and_then(Value::as_str).unwrap_or("")
    }

    fn late(&self) -> bool {
        (self.late)()
    }

    /// `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}`, the form both hosts
    /// accept for SessionStart and UserPromptSubmit (and Claude for Stop).
    fn context(event_name: &str, text: String) -> Value {
        json!({
            "hookSpecificOutput": {
                "hookEventName": event_name,
                "additionalContext": text,
            }
        })
    }

    /// SessionStart (ADR 0051): forget the session's recalls after `clear` / `compact`, then
    /// inject the project context, fitted inside the fence's budget.
    fn session_start(&self, app: &App) -> Result<Value, AppError> {
        let session = self.str("session_id");
        if matches!(self.str("source"), "clear" | "compact") {
            if self.late() {
                return Ok(empty());
            }
            app.reset_session(session)?;
        }
        if self.late() {
            return Ok(empty());
        }
        let max = app.hooks_config()?.session_start_max_chars;
        let Some(fence) =
            fence::nonce().map(|n| Fence::new(mwf_assets::HOOK_SESSION_START_INTRO, n))
        else {
            return Ok(empty());
        };
        // The wrapper is budgeted first, so nothing is cut after wrapping.
        let Some(budget) = fence.data_budget() else {
            return Ok(empty());
        };
        if self.late() {
            return Ok(empty());
        }
        let ctx = app.session_context(max.min(budget))?;
        let data = fence::clean(ctx.text.trim_end_matches('\n'));
        if data.is_empty() {
            return Ok(empty());
        }
        Ok(Self::context("SessionStart", fence.wrap(&data)))
    }

    /// UserPromptSubmit (ADR 0051): the slug, title and summary of the recalled pages, whole
    /// lines within the budget; only the pages emitted are recorded for the session.
    fn prompt(&self, app: &App) -> Result<Value, AppError> {
        let prompt = self.str("prompt");
        if is_mwf_command(prompt) {
            return Ok(empty());
        }
        if self.late() {
            return Ok(empty());
        }
        let session = self.str("session_id");
        let pages = app.recall(session, prompt)?;
        if pages.is_empty() || self.late() {
            return Ok(empty());
        }
        let Some(fence) = fence::nonce().map(|n| Fence::new(mwf_assets::HOOK_PROMPT_INTRO, n))
        else {
            return Ok(empty());
        };
        let Some(budget) = fence.data_budget() else {
            return Ok(empty());
        };
        let mut lines: Vec<String> = Vec::new();
        let mut used = 0;
        let mut emitted = Vec::new();
        for p in pages {
            let line = fence::clean(&format!("- {}: {} — {}", p.slug, p.title, p.summary));
            // Lines are joined by newlines: every line after the first costs one more.
            let cost = line.chars().count() + usize::from(!lines.is_empty());
            if used + cost > budget {
                continue;
            }
            used += cost;
            lines.push(line);
            emitted.push(p.slug);
        }
        if lines.is_empty() {
            return Ok(empty());
        }
        // Pages go out only once they are recorded, so none is shown twice.
        if self.late() {
            return Ok(empty());
        }
        // A failed save is reported like any app error (ADR 0051), not hidden.
        app.mark_recalled(session, &emitted)?;
        Ok(Self::context(
            "UserPromptSubmit",
            fence.wrap(&lines.join("\n")),
        ))
    }

    /// Stop (ADR 0051): remind once per turn; never while the host is already continuing
    /// because of a Stop hook. Errors stay silent.
    fn stop(&self, app: &App) -> Result<Value, AppError> {
        if self.input.get("stop_hook_active") == Some(&Value::Bool(true)) {
            return Ok(empty());
        }
        if self.late() {
            return Ok(empty());
        }
        let turn = match self.host {
            Host::Claude => self.str("prompt_id"),
            Host::Codex => self.str("turn_id"),
        };
        if !app.stop_reminder(self.str("session_id"), turn)? {
            return Ok(empty());
        }
        let reminder = mwf_assets::HOOK_STOP_REMINDER.trim_end();
        Ok(match self.host {
            Host::Claude => Self::context("Stop", reminder.to_owned()),
            Host::Codex => json!({ "decision": "block", "reason": reminder }),
        })
    }

    /// PreToolUse (ADR 0024): refuse edits and shell writes under a `.mwf` directory. Past
    /// the deadline the tool is allowed, as on any other failure: the deadline is checked
    /// before each path lookup, since each one walks the filesystem.
    fn pre_tool(&self, app: &App) -> Value {
        if self.late() {
            return empty();
        }
        let tool = self.str("tool_name");
        let input = self.input.get("tool_input").unwrap_or(&Value::Null);
        let field = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
        // `None` once past the deadline.
        let inside = |paths: &[&str]| -> Option<bool> {
            for p in paths.iter().filter(|p| !p.is_empty()) {
                if self.late() {
                    return None;
                }
                if app.is_inside_mwf(self.cwd, Path::new(p)) {
                    return Some(true);
                }
            }
            Some(false)
        };
        let reason = match (self.host, tool) {
            (Host::Claude, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") => {
                let path = match field("file_path") {
                    "" => field("notebook_path"),
                    p => p,
                };
                match inside(&[path]) {
                    None => return empty(),
                    Some(i) => i.then_some(mwf_assets::HOOK_DENY_EDIT),
                }
            }
            // Codex matches `apply_patch` also as `Edit` and `Write`; the patch is the command.
            (Host::Codex, "apply_patch" | "Edit" | "Write") => {
                let patch = match field("command") {
                    "" => field("patch"),
                    p => p,
                };
                match inside(&guard::patch_paths(patch)) {
                    None => return empty(),
                    Some(i) => i.then_some(mwf_assets::HOOK_DENY_EDIT),
                }
            }
            (_, "Bash" | "shell" | "exec_command" | "local_shell") => {
                let command = match input.get("command").or_else(|| input.get("cmd")) {
                    Some(Value::String(s)) => s.clone(),
                    // Codex may pass argv, as `["bash", "-lc", "…"]`.
                    Some(Value::Array(argv)) => {
                        guard::argv_command(argv.iter().filter_map(Value::as_str))
                    }
                    _ => String::new(),
                };
                guard::shell_writes_mwf(&command).then_some(mwf_assets::HOOK_DENY_SHELL)
            }
            _ => None,
        };
        match reason {
            Some(reason) => json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason.trim_end(),
                }
            }),
            None => empty(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn args_take_event_and_host_in_any_order() {
        assert_eq!(
            parse_args(&os(&["stop", "--host", "codex"])),
            Ok((Event::Stop, Host::Codex))
        );
        assert_eq!(
            parse_args(&os(&["--host=claude", "pre-tool"])),
            Ok((Event::PreTool, Host::Claude))
        );
        for bad in [
            &["stop"][..],
            &["--host", "claude"],
            &["stop", "--host", "pi"],
            &["stop", "prompt", "--host", "claude"],
            &["stop", "--host"],
            &["stop", "--host", "claude", "--json"],
            &["SessionStart", "--host", "claude"],
        ] {
            assert!(parse_args(&os(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn mwf_command_lines_are_recognized() {
        for yes in [
            "/mwf",
            "  /mwf show a",
            "/mwf:save",
            "/mwf-tidy",
            "\n/mwf\tx",
        ] {
            assert!(is_mwf_command(yes), "{yes:?}");
        }
        for no in ["/mwfx", "run /mwf", "mwf show", "/mw f"] {
            assert!(!is_mwf_command(no), "{no:?}");
        }
    }

    /// Runs one hook in `root` with `late` as the deadline check; returns stdout.
    fn hook_at(root: &Path, args: &[&str], input: Value, late: &dyn Fn() -> bool) -> String {
        let mut input = input;
        input["cwd"] = json!(root.display().to_string());
        let stdin = input.to_string();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_with(
            os(args),
            &mut Io {
                stdin: &mut stdin.as_bytes(),
                stdout: &mut out,
                stderr: &mut err,
            },
            late,
        );
        assert_eq!(code, ExitCode::SUCCESS);
        assert!(err.is_empty(), "{}", String::from_utf8_lossy(&err));
        String::from_utf8(out).unwrap()
    }

    /// A project with one page, in a temporary git root.
    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        App::init(&root, false).unwrap();
        App::open(&root)
            .unwrap()
            .new_page(mwf_app::NewIn {
                slug: "cargo-deny".to_owned(),
                page_type: "knowledge".to_owned(),
                title: "Cargo deny duplicate versions".to_owned(),
                summary: "Why duplicate crate versions fail CI".to_owned(),
                body: "deny.toml sets multiple-versions = deny.\n".to_owned(),
                ..Default::default()
            })
            .unwrap();
        (dir, root)
    }

    /// Runs the hook with a deadline that passes at its `k`-th check (from 0; never when `k`
    /// is `usize::MAX`) and returns stdout and the number of checks made.
    fn hook_late_at(root: &Path, args: &[&str], input: Value, k: usize) -> (String, usize) {
        let calls = std::cell::Cell::new(0);
        let late = || {
            calls.set(calls.get() + 1);
            calls.get() > k
        };
        let out = hook_at(root, args, input, &late);
        (out, calls.get())
    }

    #[test]
    fn past_the_deadline_every_event_skips_its_work() {
        let (_dir, root) = project();
        let cases = [
            (
                &["session-start", "--host", "claude"][..],
                json!({"session_id": "s", "source": "clear"}),
            ),
            (
                &["prompt", "--host", "codex"],
                json!({"session_id": "s", "prompt": "why do duplicate crate versions fail"}),
            ),
            (
                &["stop", "--host", "claude"],
                json!({"session_id": "s", "prompt_id": "p"}),
            ),
            (
                &["pre-tool", "--host", "claude"],
                json!({"tool_name": "Bash", "tool_input": {"command": "rm .mwf/index.md"}}),
            ),
        ];
        for (args, input) in &cases {
            assert_eq!(
                hook_at(&root, args, input.clone(), &|| true),
                "{}\n",
                "{args:?}"
            );
        }
        assert!(
            !root.join(".mwf/.state").exists(),
            "no session state written"
        );
        // The same input within the deadline does the work: the test is not vacuous.
        for (args, input) in &cases {
            assert_ne!(
                hook_at(&root, args, input.clone(), &|| false),
                "{}\n",
                "{args:?}"
            );
        }
    }

    #[test]
    fn prompt_shows_pages_only_when_it_records_them() {
        let (_dir, root) = project();
        let args = ["prompt", "--host", "claude"];
        let input =
            |id: &str| json!({"session_id": id, "prompt": "why do duplicate crate versions fail"});
        let (full, checks) = hook_late_at(&root, &args, input("full"), usize::MAX);
        assert!(full.contains("cargo-deny"), "{full}");
        // Before opening the project, on entry, after `recall`, before `mark_recalled`.
        assert_eq!(checks, 4);
        // Whenever the deadline passes, pages go out exactly when they were recorded.
        for k in 0..checks {
            let id = format!("late-{k}");
            let (out, _) = hook_late_at(&root, &args, input(&id), k);
            let recorded = root.join(format!(".mwf/.state/{id}.json")).exists();
            assert_eq!(out != "{}\n", recorded, "deadline at check {k}: {out}");
            assert_eq!(out, "{}\n", "deadline at check {k}");
        }
        // The last check is the one between `recall` and `mark_recalled`.
        let (out, _) = hook_late_at(&root, &args, input("between"), checks - 1);
        assert_eq!(out, "{}\n");
        assert!(!root.join(".mwf/.state/between.json").exists());
    }

    #[test]
    fn pre_tool_stops_looking_up_patch_paths_at_the_deadline() {
        let (_dir, root) = project();
        let args = ["pre-tool", "--host", "codex"];
        // Only the last path is inside `.mwf/`.
        let patch = "*** Begin Patch\n*** Add File: src/a.rs\n+a\n*** Add File: src/b.rs\n+b\n*** Add File: .mwf/pages/x.md\n+x\n*** End Patch\n";
        let input = json!({"tool_name": "apply_patch", "tool_input": {"command": patch}});
        let (full, checks) = hook_late_at(&root, &args, input.clone(), usize::MAX);
        assert!(full.contains("\"permissionDecision\":\"deny\""), "{full}");
        // One check before opening the project, one on entry, one before each of the paths.
        assert_eq!(checks, 5);
        for k in 0..checks {
            let (out, _) = hook_late_at(&root, &args, input.clone(), k);
            assert_eq!(out, "{}\n", "deadline at check {k}: the tool is allowed");
        }
    }

    #[test]
    fn pre_tool_denies_shell_c_scripts_from_both_hosts() {
        let (_dir, root) = project();
        for (host, command) in [
            ("claude", json!("bash -lc 'rm .mwf/pages/x.md'")),
            ("codex", json!(["bash", "-lc", "rm .mwf/pages/x.md"])),
            (
                "codex",
                json!(["sh", "-c", "sed -i 's/a/b/' .mwf/pages/x.md"]),
            ),
        ] {
            let input = json!({"tool_name": "Bash", "tool_input": {"command": command}});
            let (out, _) = hook_late_at(&root, &["pre-tool", "--host", host], input, usize::MAX);
            assert!(out.contains("\"permissionDecision\":\"deny\""), "{out}");
        }
        let input = json!({"tool_name": "Bash", "tool_input": {"command": ["bash", "-lc", "cat .mwf/log.md"]}});
        let (out, _) = hook_late_at(&root, &["pre-tool", "--host", "codex"], input, usize::MAX);
        assert_eq!(out, "{}\n");
    }

    #[test]
    fn bad_input_prints_empty_object_and_one_stderr_line() {
        for (args, stdin) in [
            (&["nope", "--host", "claude"][..], "{}".to_owned()),
            (&["stop", "--host", "claude"], "not json".to_owned()),
            (&["stop", "--host", "claude"], "[1]".to_owned()),
            (
                &["stop", "--host", "claude"],
                format!("\"{}\"", "x".repeat(STDIN_MAX_BYTES as usize)),
            ),
        ] {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = run(
                os(args),
                &mut Io {
                    stdin: &mut stdin.as_bytes(),
                    stdout: &mut out,
                    stderr: &mut err,
                },
            );
            assert_eq!(code, ExitCode::SUCCESS);
            assert_eq!(String::from_utf8(out).unwrap(), "{}\n");
            let err = String::from_utf8(err).unwrap();
            assert!(
                err.starts_with("mwf hook: ") && err.lines().count() == 1,
                "{err}"
            );
        }
    }
}
