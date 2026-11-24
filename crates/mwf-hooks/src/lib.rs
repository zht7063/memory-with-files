//! Hook adapter: `mwf hook session-start|prompt|stop|pre-tool --host claude|codex|pi|antigravity`.
//!
//! See [docs/crates/adapters.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/adapters.md)
//! and ADRs 0051 and 0055. Every run exits 0 and prints exactly one line of JSON: whatever goes wrong,
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
    /// pi, through mwf's bridge extension, which sends and reads Claude's shapes (ADR 0055).
    Pi,
    /// Google Antigravity (`agy`), whose hooks differ in names and shapes (ADR 0055).
    Antigravity,
}

impl Host {
    fn parse(value: &str) -> Option<Host> {
        match value {
            "claude" => Some(Host::Claude),
            "codex" => Some(Host::Codex),
            "pi" => Some(Host::Pi),
            "antigravity" | "agy" => Some(Host::Antigravity),
            _ => None,
        }
    }
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
/// input print the "nothing to do" output and one `mwf hook: …` line on stderr (ADR 0051).
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
    // Antigravity blocks the tool when a PreToolUse hook prints `{}` or fails, so every way of
    // doing nothing there allows it explicitly (ADR 0055). The host and event are looked for
    // in the raw arguments, so bad arguments or input still allow.
    let out = if out == empty() && allows_explicitly(&args) {
        json!({ "decision": "allow" })
    } else {
        out
    };
    let _ = writeln!(io.stdout, "{out}");
    let _ = io.stdout.flush();
    ExitCode::SUCCESS
}

fn empty() -> Value {
    Value::Object(Map::new())
}

/// Whether the arguments name Antigravity's pre-tool hook, even when they are otherwise bad.
fn allows_explicitly(args: &[OsString]) -> bool {
    let mut it = args.iter().map(|a| a.to_string_lossy());
    let (mut agy, mut pre_tool) = (false, false);
    while let Some(arg) = it.next() {
        let value = if arg == "--host" {
            it.next().map(|v| v.into_owned())
        } else {
            arg.strip_prefix("--host=").map(str::to_owned)
        };
        match value {
            Some(v) => agy |= Host::parse(&v) == Some(Host::Antigravity),
            None => pre_tool |= arg == "pre-tool",
        }
    }
    agy && pre_tool
}

/// The project directory a hook works in: the host's `cwd` when it is absolute. Antigravity
/// also gives `workspacePaths`; its hooks run in the plugin's directory, so there is no
/// fallback to the process directory for it (ADR 0055).
fn working_dir(host: Host, input: &Value) -> Option<PathBuf> {
    let absolute = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    let cwd = absolute(input.get("cwd"));
    match host {
        Host::Antigravity => cwd.or_else(|| absolute(input.pointer("/workspacePaths/0"))),
        Host::Claude | Host::Codex | Host::Pi => cwd.or_else(|| std::env::current_dir().ok()),
    }
}

/// The output of one run; `Err` is bad arguments or input, for stderr.
fn handle(
    args: &[OsString],
    stdin: &mut dyn Read,
    late: &dyn Fn() -> bool,
) -> Result<Value, String> {
    let (event, host) = parse_args(args)?;
    let input = read_input(stdin)?;
    let cwd = working_dir(host, &input).ok_or("no absolute working directory")?;
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
        Err(e) => return Ok(hook.failed(event, &e)),
    };
    let out = match event {
        Event::SessionStart => hook.session_start(&app),
        Event::Prompt => hook.prompt(&app),
        Event::Stop => hook.stop(&app),
        Event::PreTool => Ok(hook.pre_tool(&app)),
    };
    Ok(out.unwrap_or_else(|e| hook.failed(event, &e)))
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
            let h = Host::parse(&value).ok_or_else(|| {
                format!("unknown host {value:?}; use claude, codex, pi or antigravity")
            })?;
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
        (_, None) => Err("missing --host claude|codex|pi|antigravity".to_owned()),
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

    /// The host's session id.
    fn session(&self) -> &str {
        match self.host {
            Host::Antigravity => self.str("conversationId"),
            Host::Claude | Host::Codex | Host::Pi => self.str("session_id"),
        }
    }

    /// Text for the agent's context: `{"hookSpecificOutput":{"hookEventName":…,
    /// "additionalContext":…}}`, the form Claude Code and Codex accept for SessionStart and
    /// UserPromptSubmit (and Claude for Stop); for Antigravity, one injected system message.
    fn context(&self, event_name: &str, text: String) -> Value {
        match self.host {
            Host::Antigravity => json!({
                "injectSteps": [{ "systemMessage": { "systemMessage": text } }]
            }),
            Host::Claude | Host::Codex | Host::Pi => json!({
                "hookSpecificOutput": {
                    "hookEventName": event_name,
                    "additionalContext": text,
                }
            }),
        }
    }

    /// What an app error shows (ADR 0051): the code only (a path could hold a secret-looking
    /// slug) where memory was not injected, as a `systemMessage` for the user; Antigravity has
    /// no such field, so the agent gets it to relay (ADR 0055). Nothing for Stop and
    /// PreToolUse: the guard lets the tool run.
    fn failed(&self, event: Event, e: &AppError) -> Value {
        let text = format!(
            "mwf: {} hook skipped ({}); run `mwf lint`",
            event.name(),
            e.code.as_str()
        );
        match (event, self.host) {
            (Event::SessionStart | Event::Prompt, Host::Antigravity) => self.context("", text),
            (Event::SessionStart | Event::Prompt, _) => json!({ "systemMessage": text }),
            (Event::Stop | Event::PreTool, _) => empty(),
        }
    }

    /// SessionStart (ADR 0051): forget the session's recalls after `clear` / `compact`, then
    /// inject the project context, fitted inside the fence's budget.
    fn session_start(&self, app: &App) -> Result<Value, AppError> {
        let session = self.session();
        // Antigravity has no `source`: `/clear` starts a new conversation, and it has no
        // compaction event (ADR 0055).
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
        Ok(self.context("SessionStart", fence.wrap(&data)))
    }

    /// UserPromptSubmit (ADR 0051): the slug, title and summary of the recalled pages, whole
    /// lines within the budget; only the pages emitted are recorded for the session.
    fn prompt(&self, app: &App) -> Result<Value, AppError> {
        let prompt = match self.host {
            // PreInvocation runs before every model call and its injections pile up; the
            // count starts at 0 with each user prompt, so recall runs then only (ADR 0055).
            Host::Antigravity if self.input.get("invocationNum") != Some(&json!(0)) => {
                return Ok(empty());
            }
            Host::Antigravity => self.str("lastUserInput"),
            Host::Claude | Host::Codex | Host::Pi => self.str("prompt"),
        };
        if is_mwf_command(prompt) {
            return Ok(empty());
        }
        if self.late() {
            return Ok(empty());
        }
        let session = self.session();
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
        Ok(self.context("UserPromptSubmit", fence.wrap(&lines.join("\n"))))
    }

    /// Stop (ADR 0051): remind once per turn; never while the host is already continuing
    /// because of a Stop hook. Errors stay silent.
    fn stop(&self, app: &App) -> Result<Value, AppError> {
        let continuing = match self.host {
            Host::Claude | Host::Codex | Host::Pi => {
                self.input.get("stop_hook_active") == Some(&Value::Bool(true))
            }
            // `executionNum` counts the continuations of this prompt. A model error also
            // reaches Stop, and continuing would retry the failed turn; a user's Esc fires no
            // Stop at all. So only a clean finish of the prompt's first run is reminded
            // (ADR 0055).
            Host::Antigravity => {
                self.input.get("executionNum") != Some(&json!(0))
                    || !self.str("error").is_empty()
                    || !matches!(
                        self.str("terminationReason").to_ascii_lowercase().as_str(),
                        "no_tool_call" | "model_stop"
                    )
            }
        };
        if continuing || self.late() {
            return Ok(empty());
        }
        let turn = match self.host {
            Host::Claude | Host::Pi => self.str("prompt_id"),
            Host::Codex => self.str("turn_id"),
            // No turn id: `executionNum` already limits the reminder to one per prompt.
            Host::Antigravity => "",
        };
        if !app.stop_reminder(self.session(), turn)? {
            return Ok(empty());
        }
        let reminder = mwf_assets::HOOK_STOP_REMINDER.trim_end();
        Ok(match self.host {
            Host::Claude | Host::Pi => self.context("Stop", reminder.to_owned()),
            Host::Codex => json!({ "decision": "block", "reason": reminder }),
            Host::Antigravity => json!({ "decision": "continue", "reason": reminder }),
        })
    }

    /// PreToolUse (ADR 0024): refuse edits and shell writes under a `.mwf` directory. Past
    /// the deadline the tool is allowed, as on any other failure: the deadline is checked
    /// before each path lookup, since each one walks the filesystem.
    fn pre_tool(&self, app: &App) -> Value {
        if self.late() {
            return empty();
        }
        let (tool, input) = match self.host {
            Host::Antigravity => (
                self.input
                    .pointer("/toolCall/name")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                self.input.pointer("/toolCall/args").unwrap_or(&Value::Null),
            ),
            Host::Claude | Host::Codex | Host::Pi => (
                self.str("tool_name"),
                self.input.get("tool_input").unwrap_or(&Value::Null),
            ),
        };
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
            (Host::Antigravity, "write_file" | "edit_file") => match inside(&[field("Path")]) {
                None => return empty(),
                Some(i) => i.then_some(mwf_assets::HOOK_DENY_EDIT),
            },
            (Host::Antigravity, "run_command") => {
                guard::shell_writes_mwf(field("CommandLine")).then_some(mwf_assets::HOOK_DENY_SHELL)
            }
            // pi rewrites the path before it writes (`@`, `~`, `file://`): check what it means.
            (Host::Pi, "write" | "edit") => {
                let raw = field("path");
                let meant = guard::pi_path(raw, std::env::home_dir().as_deref());
                match inside(&[raw, &meant.to_string_lossy()]) {
                    None => return empty(),
                    Some(i) => i.then_some(mwf_assets::HOOK_DENY_EDIT),
                }
            }
            (Host::Pi, "bash") => {
                guard::shell_writes_mwf(field("command")).then_some(mwf_assets::HOOK_DENY_SHELL)
            }
            (Host::Claude | Host::Codex, "Bash" | "shell" | "exec_command" | "local_shell") => {
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
        match (reason, self.host) {
            (Some(reason), Host::Antigravity) => {
                json!({ "decision": "deny", "reason": reason.trim_end() })
            }
            (Some(reason), _) => json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason.trim_end(),
                }
            }),
            (None, _) => empty(),
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
        for agy in ["antigravity", "agy"] {
            assert_eq!(
                parse_args(&os(&["prompt", "--host", agy])),
                Ok((Event::Prompt, Host::Antigravity))
            );
        }
        for bad in [
            &["stop"][..],
            &["--host", "claude"],
            &["stop", "--host", "pie"],
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
            ("claude", json!("bash -lc\"rm .mwf/pages/x.md\"")),
            (
                "claude",
                json!("env VAR=1 sh -c \"echo x>.mwf/pages/a.md\""),
            ),
            ("codex", json!(["bash", "-c", "--", "rm .mwf/pages/x.md"])),
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

    /// stdout and stderr of one run with `stdin` as is.
    fn raw(args: &[&str], stdin: &str) -> (String, String) {
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
        (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    const ALLOW: &str = "{\"decision\":\"allow\"}\n";

    #[test]
    fn antigravity_pre_tool_denies_mwf_writes_and_allows_the_rest_explicitly() {
        let (_dir, root) = project();
        let args = ["pre-tool", "--host", "agy"];
        let call =
            |name: &str, tool_args: Value| json!({"toolCall": {"name": name, "args": tool_args}});
        for input in [
            call(
                "write_file",
                json!({"Path": ".mwf/pages/x.md", "Content": "x"}),
            ),
            call(
                "edit_file",
                json!({"Path": root.join(".mwf/log.md").display().to_string(), "Target": "a", "Replacement": "b"}),
            ),
            call(
                "run_command",
                json!({"CommandLine": "bash -lc 'rm .mwf/log.md'", "toolSummary": "rm"}),
            ),
        ] {
            let (out, _) = hook_late_at(&root, &args, input.clone(), usize::MAX);
            assert!(
                out.starts_with("{\"decision\":\"deny\",\"reason\":\""),
                "{input}: {out}"
            );
        }
        // Allowed: other paths, other tools, Claude's tool names, and past the deadline.
        for input in [
            call("write_file", json!({"Path": "notes.md", "Content": "x"})),
            call("run_command", json!({"CommandLine": "cat .mwf/log.md"})),
            call("read_file", json!({"Path": ".mwf/log.md"})),
            json!({"tool_name": "Bash", "tool_input": {"command": "rm .mwf/log.md"}}),
        ] {
            let (out, _) = hook_late_at(&root, &args, input.clone(), usize::MAX);
            assert_eq!(out, ALLOW, "{input}");
        }
        let input = call("write_file", json!({"Path": ".mwf/pages/x.md"}));
        assert_eq!(hook_at(&root, &args, input, &|| true), ALLOW);
    }

    #[test]
    fn antigravity_pre_tool_allows_on_every_failure() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().display().to_string();
        let write = |cwd: Value| {
            json!({"cwd": cwd, "toolCall": {"name": "write_file", "args": {"Path": ".mwf/x.md"}}})
                .to_string()
        };
        for (args, stdin, stderr) in [
            // No `.mwf/`; no usable working directory; bad input; bad arguments.
            (
                &["pre-tool", "--host", "antigravity"][..],
                write(json!(elsewhere)),
                false,
            ),
            (
                &["pre-tool", "--host", "antigravity"],
                write(json!("relative")),
                true,
            ),
            (
                &["pre-tool", "--host", "antigravity"],
                write(Value::Null),
                true,
            ),
            (
                &["pre-tool", "--host", "antigravity"],
                "not json".to_owned(),
                true,
            ),
            (
                &["pre-tool", "--host=agy", "--verbose"],
                write(json!(elsewhere)),
                true,
            ),
            (
                &["pre-tool", "--host", "agy", "--host", "agy"],
                "{}".to_owned(),
                true,
            ),
        ] {
            let (out, err) = raw(args, &stdin);
            assert_eq!(out, ALLOW, "{args:?} {stdin}");
            assert_eq!(err.lines().count(), usize::from(stderr), "{args:?}: {err}");
        }
        // The other events, and other hosts, keep `{}`.
        assert_eq!(raw(&["stop", "--host", "agy"], "not json").0, "{}\n");
        assert_eq!(raw(&["pre-tool", "--host", "claude"], "not json").0, "{}\n");
    }

    #[test]
    fn antigravity_without_an_absolute_cwd_uses_the_workspace_or_does_nothing() {
        let (_dir, root) = project();
        let input = |cwd: Value, ws: Value| {
            json!({"cwd": cwd, "workspacePaths": ws, "conversationId": "c", "hookEventName": "SessionStart"})
                .to_string()
        };
        let args = ["session-start", "--host", "antigravity"];
        let root_s = root.display().to_string();
        let (out, _) = raw(&args, &input(json!("rel"), json!([root_s])));
        assert!(
            out.contains("injectSteps") && out.contains("cargo-deny"),
            "{out}"
        );
        // Not the process directory: with neither, nothing is injected.
        let (out, err) = raw(&args, &input(json!("rel"), json!(["also/rel"])));
        assert_eq!(out, "{}\n");
        assert!(err.contains("working directory"), "{err}");
    }

    #[test]
    fn antigravity_recalls_once_per_prompt_and_reminds_only_after_a_clean_first_run() {
        let (_dir, root) = project();
        let prompt = |n: u64, id: &str| json!({"conversationId": id, "invocationNum": n, "lastUserInput": "why do duplicate crate versions fail"});
        let args = ["prompt", "--host", "antigravity"];
        let (later, _) = hook_late_at(&root, &args, prompt(1, "a"), usize::MAX);
        assert_eq!(later, "{}\n", "not before later model calls");
        let (first, _) = hook_late_at(&root, &args, prompt(0, "a"), usize::MAX);
        assert!(
            first.starts_with("{\"injectSteps\":[{\"systemMessage\":{\"systemMessage\":")
                && first.contains("cargo-deny"),
            "{first}"
        );

        let stop = |n: u64, reason: &str, error: &str| json!({"conversationId": "s", "executionNum": n, "terminationReason": reason, "error": error, "fullyIdle": true});
        let args = ["stop", "--host", "antigravity"];
        let (out, _) = hook_late_at(&root, &args, stop(0, "NO_TOOL_CALL", ""), usize::MAX);
        assert!(
            out.starts_with("{\"decision\":\"continue\",\"reason\":\""),
            "{out}"
        );
        for input in [
            stop(1, "NO_TOOL_CALL", ""),
            stop(0, "ERROR", "Error 400"),
            stop(0, "max_steps_exceeded", ""),
            json!({"conversationId": "s", "terminationReason": "NO_TOOL_CALL"}),
        ] {
            let (out, _) = hook_late_at(&root, &args, input.clone(), usize::MAX);
            assert_eq!(out, "{}\n", "{input}");
        }
    }

    #[test]
    fn pi_uses_claude_shapes_with_pi_tool_names() {
        let (_dir, root) = project();
        let deny = |out: &str| out.contains("\"permissionDecision\":\"deny\"");
        let args = ["pre-tool", "--host", "pi"];
        for (input, denied) in [
            (
                json!({"tool_name": "write", "tool_input": {"path": ".mwf/pages/x.md", "content": "x"}}),
                true,
            ),
            (
                json!({"tool_name": "edit", "tool_input": {"path": root.join(".mwf/log.md").display().to_string(), "edits": []}}),
                true,
            ),
            (
                json!({"tool_name": "bash", "tool_input": {"command": "bash -lc 'rm .mwf/log.md'"}}),
                true,
            ),
            (
                json!({"tool_name": "write", "tool_input": {"path": "notes.md"}}),
                false,
            ),
            (
                json!({"tool_name": "bash", "tool_input": {"command": "mwf list"}}),
                false,
            ),
            // Claude's names are not pi's tools.
            (
                json!({"tool_name": "Write", "tool_input": {"file_path": ".mwf/x.md"}}),
                false,
            ),
            // pi drops a leading `@` and reads `file://` URLs before it writes.
            (
                json!({"tool_name": "write", "tool_input": {"path": "@.mwf/log.md"}}),
                true,
            ),
            (
                json!({"tool_name": "edit", "tool_input": {"path": format!("@{}", root.join(".mwf/x.md").display())}}),
                true,
            ),
            (
                json!({"tool_name": "write", "tool_input": {"path": format!("file://{}/%2Emwf/x.md?v=1", root.display())}}),
                true,
            ),
            (
                json!({"tool_name": "write", "tool_input": {"path": "@@.mwf/log.md"}}),
                false,
            ),
            (
                json!({"tool_name": "write", "tool_input": {"path": "@notes.md"}}),
                false,
            ),
        ] {
            let (out, _) = hook_late_at(&root, &args, input.clone(), usize::MAX);
            assert_eq!(deny(&out), denied, "{input}: {out}");
            if !denied {
                assert_eq!(out, "{}\n", "pi allows with nothing");
            }
        }
        let prompt = json!({"session_id": "p", "prompt": "why do duplicate crate versions fail"});
        let (out, _) = hook_late_at(&root, &["prompt", "--host", "pi"], prompt, usize::MAX);
        assert!(
            out.contains("\"additionalContext\"") && out.contains("cargo-deny"),
            "{out}"
        );
        let stop = |id: &str, active: bool| json!({"session_id": "p", "prompt_id": id, "stop_hook_active": active});
        let args = ["stop", "--host", "pi"];
        let (out, _) = hook_late_at(&root, &args, stop("load1-1", false), usize::MAX);
        assert!(out.contains("\"hookEventName\":\"Stop\""), "{out}");
        for (id, active) in [("load1-1", false), ("load1-2", true)] {
            let (out, _) = hook_late_at(&root, &args, stop(id, active), usize::MAX);
            assert_eq!(out, "{}\n", "{id} {active}");
        }
        let (out, _) = hook_late_at(&root, &args, stop("load2-1", false), usize::MAX);
        assert_ne!(out, "{}\n", "a new load's prompt id is a new turn");
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
