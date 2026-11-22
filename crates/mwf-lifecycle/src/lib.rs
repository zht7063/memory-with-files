//! Lifecycle adapter: `mwf install|uninstall --host claude|codex [--dry-run] [--json]`.
//!
//! See [docs/crates/adapters.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/adapters.md)
//! and ADRs 0031, 0037 and 0052. `install` adds mwf's four hooks to the host's hooks document and
//! writes the `mwf` skill; `uninstall` removes exactly those. Nothing else in the host's files
//! changes, and no project's `.mwf/` is read or written.

mod fsx;
mod hooks;
mod json;

use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use hooks::Status;
use json::{Json, Span, Style};

/// The standard streams of one run; tests can pass buffers. `stdin` is not read.
pub struct Io<'a> {
    pub stdin: &'a mut dyn Read,
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Host {
    Claude,
    Codex,
}

impl Host {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Host::Claude => "claude",
            Host::Codex => "codex",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Host::Claude => "Claude Code",
            Host::Codex => "Codex",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    Install,
    Uninstall,
}

impl Action {
    fn name(self) -> &'static str {
        match self {
            Action::Install => "install",
            Action::Uninstall => "uninstall",
        }
    }
}

/// A failure: an error code of docs/cli.md and a message.
#[derive(Debug)]
pub(crate) struct Error {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl Error {
    pub(crate) fn new(code: &'static str, message: String) -> Error {
        Error { code, message }
    }

    pub(crate) fn io(path: &Path, e: &io::Error) -> Error {
        Error::new("IO", format!("{}: {e}", path.display()))
    }
}

/// What the process environment says; tests build their own.
struct Env {
    home: Option<OsString>,
    claude_config_dir: Option<OsString>,
    codex_home: Option<OsString>,
    path: Option<OsString>,
    exe: io::Result<PathBuf>,
}

impl Env {
    fn from_process() -> Env {
        Env {
            home: std::env::var_os("HOME"),
            claude_config_dir: std::env::var_os("CLAUDE_CONFIG_DIR"),
            codex_home: std::env::var_os("CODEX_HOME"),
            path: std::env::var_os("PATH"),
            exe: std::env::current_exe(),
        }
    }
}

/// Runs `install` or `uninstall`. `args` start with the command (`["install", "--host",
/// "claude"]`). Exit codes as the CLI: 0 done, 1 failed, 2 usage error (ADR 0050).
pub fn run(args: Vec<OsString>, io: &mut Io) -> ExitCode {
    run_with(&args, io, &Env::from_process())
}

fn run_with(args: &[OsString], io: &mut Io, env: &Env) -> ExitCode {
    let json = args.iter().any(|a| a == "--json");
    let action = match args
        .iter()
        .find(|a| *a != "--json")
        .and_then(|a| a.to_str())
    {
        Some("uninstall") => Action::Uninstall,
        _ => Action::Install,
    };
    let (stdout, code) = match parse(args) {
        Ok(Parsed::Help) => (usage(action), 0),
        Ok(Parsed::Run(cmd)) => match execute(&cmd, env) {
            Ok(report) if json => (
                format!("{{\"ok\":true,\"data\":{}}}\n", report.to_json().compact()),
                0,
            ),
            Ok(report) => (report.to_text(), 0),
            Err(e) if json => (error_json(&e), 1),
            Err(e) => {
                let _ = writeln!(io.stderr, "error[{}]: {}", e.code, e.message);
                (String::new(), 1)
            }
        },
        Err(why) => {
            let text = format!(
                "{why}\n\nUsage: mwf {} --host <HOST> [--dry-run] [--json]\n\nFor more information, try '--help'.\n",
                action.name()
            );
            if json {
                (error_json(&Error::new("USAGE", text)), 2)
            } else {
                let _ = write!(io.stderr, "error: {text}");
                (String::new(), 2)
            }
        }
    };
    if io
        .stdout
        .write_all(stdout.as_bytes())
        .and_then(|()| io.stdout.flush())
        .is_err()
    {
        return ExitCode::from(1);
    }
    ExitCode::from(code)
}

fn error_json(e: &Error) -> String {
    let error = Json::object(vec![
        ("code", Json::str(e.code)),
        ("message", Json::str(&e.message)),
    ]);
    format!("{{\"ok\":false,\"error\":{}}}\n", error.compact())
}

fn usage(action: Action) -> String {
    let what = match action {
        Action::Install => "Add mwf's hooks and the mwf skill to a host (Claude Code or Codex)",
        Action::Uninstall => {
            "Remove mwf's hooks and the mwf skill from a host; project wikis (.mwf/) stay"
        }
    };
    format!(
        "{what}

Usage: mwf {} --host <HOST> [--dry-run] [--json]

Options:
      --host <HOST>  claude or codex
      --dry-run      Print what would change; write nothing
      --json         Print `{{\"ok\": true, \"data\": …}}` or `{{\"ok\": false, \"error\": …}}` instead of text
  -h, --help         Print help

Files:
  claude  $CLAUDE_CONFIG_DIR (default ~/.claude): settings.json and skills/mwf/
  codex   $CODEX_HOME (default ~/.codex): hooks.json; and ~/.agents/skills/mwf/
",
        action.name()
    )
}

struct Command {
    action: Action,
    host: Host,
    dry_run: bool,
}

enum Parsed {
    Help,
    Run(Command),
}

/// Parses the arguments. Messages never repeat an argument's value: it could be a secret, and
/// this crate has no secret scanner (ADR 0052).
fn parse(args: &[OsString]) -> Result<Parsed, String> {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        return Ok(Parsed::Help);
    }
    // `--json` may come before the command too, as for the other commands (ADR 0050).
    let mut it = args.iter().filter(|a| *a != "--json");
    let action = match it.next().and_then(|a| a.to_str()) {
        Some("install") => Action::Install,
        Some("uninstall") => Action::Uninstall,
        _ => return Err("expected install or uninstall".to_owned()),
    };
    let mut host = None;
    let mut dry_run = false;
    while let Some(arg) = it.next() {
        let arg = arg.to_str().ok_or("arguments must be UTF-8")?;
        let value = match arg {
            "--host" => Some(
                it.next()
                    .ok_or("a value is required for '--host <HOST>'")?
                    .to_str()
                    .unwrap_or(""),
            ),
            _ => arg.strip_prefix("--host="),
        };
        if let Some(value) = value {
            let h = match value {
                "claude" => Host::Claude,
                "codex" => Host::Codex,
                _ => {
                    return Err("invalid value for '--host <HOST>': use claude or codex".to_owned());
                }
            };
            if host.replace(h).is_some() {
                return Err("the argument '--host <HOST>' cannot be used multiple times".to_owned());
            }
            continue;
        }
        match arg {
            "--dry-run" => dry_run = true,
            "--json" => {}
            _ if arg.starts_with('-') => return Err("unexpected option".to_owned()),
            _ => return Err("unexpected argument".to_owned()),
        }
    }
    let host = host.ok_or("the following required arguments were not provided: --host <HOST>")?;
    Ok(Parsed::Run(Command {
        action,
        host,
        dry_run,
    }))
}

/// Where a host's files are: each path is a base directory, which may be a symbolic link, and a
/// path below it, which may not (ADR 0052).
struct Layout {
    hooks_base: PathBuf,
    hooks_rel: PathBuf,
    skill_base: PathBuf,
    skill_rel: PathBuf,
}

/// The directory in `var`, when it is set and not empty; it must be absolute.
fn dir_var(value: Option<&OsString>, name: &str) -> Result<Option<PathBuf>, Error> {
    match value {
        Some(v) if !v.is_empty() => {
            let p = PathBuf::from(v);
            if p.is_absolute() {
                Ok(Some(p))
            } else {
                Err(Error::new(
                    "INVALID_ENV",
                    format!("{name} must be an absolute path"),
                ))
            }
        }
        _ => Ok(None),
    }
}

fn home(env: &Env) -> Result<(PathBuf, &'static str), Error> {
    dir_var(env.home.as_ref(), "HOME")?
        .map(|h| (h, "HOME"))
        .ok_or_else(|| Error::new("INVALID_ENV", "HOME is not set".to_owned()))
}

fn layout(host: Host, env: &Env) -> Result<Layout, Error> {
    let (hooks, skill) = match host {
        Host::Claude => match dir_var(env.claude_config_dir.as_ref(), "CLAUDE_CONFIG_DIR")? {
            Some(dir) => (
                (dir.clone(), "CLAUDE_CONFIG_DIR", "settings.json"),
                (dir, "CLAUDE_CONFIG_DIR", "skills/mwf"),
            ),
            None => {
                let (h, name) = home(env)?;
                (
                    (h.clone(), name, ".claude/settings.json"),
                    (h, name, ".claude/skills/mwf"),
                )
            }
        },
        Host::Codex => {
            let (h, name) = home(env)?;
            let hooks = match dir_var(env.codex_home.as_ref(), "CODEX_HOME")? {
                Some(dir) => (dir, "CODEX_HOME", "hooks.json"),
                None => (h.clone(), name, ".codex/hooks.json"),
            };
            (hooks, (h, name, ".agents/skills/mwf"))
        }
    };
    for (base, name, _) in [&hooks, &skill] {
        if !fs::metadata(base).is_ok_and(|m| m.is_dir()) {
            return Err(Error::new(
                "INVALID_ENV",
                format!("{name} ({}) is not a directory", base.display()),
            ));
        }
    }
    Ok(Layout {
        hooks_base: hooks.0,
        hooks_rel: PathBuf::from(hooks.2),
        skill_base: skill.0,
        skill_rel: PathBuf::from(skill.2),
    })
}

/// The program the hook commands run (ADRs 0037, 0052): `mwf` when the first `mwf` that a
/// shell would find on `PATH` is this binary, else this binary's path as the OS reports it,
/// without resolving links. A relative `PATH` entry (`.`, `bin`, or an empty entry, which means
/// the current directory) before the first absolute match makes `mwf` depend on the directory
/// the host runs the hook in, so the path is used then too. The binary must be named `mwf`:
/// `uninstall` and a later `install` recognise their hooks by that name.
fn program(env: &Env) -> Result<(String, Option<String>), Error> {
    let exe = env
        .exe
        .as_ref()
        .map_err(|e| Error::new("IO", format!("cannot find this mwf binary: {e}")))?;
    let exe_str = exe.to_str().ok_or_else(|| {
        Error::new(
            "IO",
            format!(
                "the path of this mwf binary is not UTF-8: {}",
                exe.display()
            ),
        )
    })?;
    if exe.file_name().is_none_or(|n| n != "mwf") {
        return Err(Error::new(
            "INVALID_EXECUTABLE",
            format!(
                "this binary is {exe_str}; install only from a binary named mwf, because uninstall finds the hooks by that name"
            ),
        ));
    }
    let same = |a: &Path| match (fs::canonicalize(a), fs::canonicalize(exe)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    let mut found = None;
    for dir in env
        .path
        .as_ref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
    {
        if !dir.is_absolute() {
            return Ok((
                exe_str.to_owned(),
                Some(format!(
                    "PATH has a relative directory before any mwf, so which mwf a hook finds depends on where it runs; the hooks run {exe_str}"
                )),
            ));
        }
        let candidate = dir.join("mwf");
        if candidate.is_file() {
            found = Some(candidate);
            break;
        }
    }
    Ok(match found {
        Some(p) if same(&p) => ("mwf".to_owned(), None),
        Some(p) => (
            exe_str.to_owned(),
            Some(format!(
                "the first mwf on PATH ({}) is another binary, so the hooks run {exe_str}",
                p.display()
            )),
        ),
        None => (
            exe_str.to_owned(),
            Some(format!(
                "mwf is not on PATH, so the hooks run {exe_str}; run install again if it moves"
            )),
        ),
    })
}

/// One file to change: `new == None` removes it.
struct Change {
    base: PathBuf,
    rel: PathBuf,
    old: Option<Vec<u8>>,
    new: Option<Vec<u8>>,
    backup: bool,
}

struct FileReport {
    name: String,
    status: &'static str,
    backup: Option<PathBuf>,
    change: Option<Change>,
}

struct Report {
    action: Action,
    host: Host,
    dry_run: bool,
    command: Option<String>,
    hooks_path: PathBuf,
    hooks: FileReport,
    events: Events,
    skill_dir: PathBuf,
    skill: Vec<FileReport>,
    notes: Vec<String>,
}

fn host_config_invalid(path: &Path, why: &str) -> Error {
    Error::new(
        "HOST_CONFIG_INVALID",
        format!(
            "{} {why}; fix it and run the command again (nothing was changed)",
            path.display()
        ),
    )
}

/// The status of each host event.
type Events = Vec<(&'static str, Status)>;

/// The hooks document's change and the status of each event.
fn plan_hooks(
    layout: &Layout,
    cmd: &Command,
    program: &str,
) -> Result<(FileReport, Events), Error> {
    let (base, rel) = (&layout.hooks_base, &layout.hooks_rel);
    let path = base.join(rel);
    let old = fsx::read(base, rel)?;
    let text = match &old {
        Some(bytes) => Some(
            std::str::from_utf8(bytes).map_err(|_| host_config_invalid(&path, "is not UTF-8"))?,
        ),
        None => None,
    };
    let (mut doc, style) = match text {
        // An empty file is an empty document; anything else must be JSON, even blank space.
        Some(t) if !t.is_empty() => (
            json::parse(t)
                .map_err(|e| host_config_invalid(&path, &format!("is not valid JSON: {e}")))?,
            Style::of(t),
        ),
        _ => (Json::Object(Vec::new(), Span::default()), Style::default()),
    };
    let events = match cmd.action {
        Action::Install => hooks::install(&mut doc, cmd.host, program),
        Action::Uninstall => hooks::uninstall(&mut doc, cmd.host),
    }
    .map_err(|e| host_config_invalid(&path, &format!("has an unexpected shape: {e}")))?;
    let changed = events
        .iter()
        .any(|(_, s)| !matches!(s, Status::Unchanged | Status::Absent));
    let emptied = matches!(&doc, Json::Object(e, _) if e.is_empty());
    let (status, new, backup) = match (cmd.action, &old, changed) {
        (_, _, false) if old.is_none() => ("absent", None, false),
        (_, _, false) => ("unchanged", None, false),
        (Action::Install, None, true) => ("created", Some(doc.pretty(&style)), false),
        // Removing the last of a document that held only mwf's hooks loses nothing of the user's.
        (Action::Uninstall, Some(_), true) if emptied => ("removed", None, false),
        (_, _, true) => ("updated", Some(doc.pretty(&style)), true),
    };
    let change = (status != "unchanged" && status != "absent").then(|| Change {
        base: base.clone(),
        rel: rel.clone(),
        old: old.clone(),
        new: new.map(String::into_bytes),
        backup,
    });
    Ok((
        FileReport {
            name: path.display().to_string(),
            status,
            backup: None,
            change,
        },
        events,
    ))
}

/// The skill files' changes (ADR 0052: the `mwf` skill directory is mwf's).
fn plan_skill(layout: &Layout, action: Action) -> Result<Vec<FileReport>, Error> {
    let mut out = Vec::new();
    for (rel, content) in mwf_assets::SKILL_FILES {
        let file_rel = layout.skill_rel.join(rel);
        let old = fsx::read(&layout.skill_base, &file_rel)?;
        let same = old.as_deref() == Some(content.as_bytes());
        let (status, new, backup) = match (action, &old) {
            (Action::Install, None) => ("created", Some(content.as_bytes().to_vec()), false),
            (Action::Install, Some(_)) if same => ("unchanged", None, false),
            (Action::Install, Some(_)) => ("updated", Some(content.as_bytes().to_vec()), true),
            (Action::Uninstall, None) => ("absent", None, false),
            // An edited or older file is backed up before it goes.
            (Action::Uninstall, Some(_)) => ("removed", None, !same),
        };
        let change = (status != "unchanged" && status != "absent").then(|| Change {
            base: layout.skill_base.clone(),
            rel: file_rel,
            old: old.clone(),
            new,
            backup,
        });
        out.push(FileReport {
            name: (*rel).to_owned(),
            status,
            backup: None,
            change,
        });
    }
    Ok(out)
}

fn apply(file: &mut FileReport) -> Result<(), Error> {
    if let Some(c) = file.change.take() {
        file.backup = match (&c.new, &c.old) {
            (Some(new), old) => fsx::write(&c.base, &c.rel, old.as_deref(), new, c.backup)?,
            (None, Some(old)) => fsx::remove(&c.base, &c.rel, old, c.backup)?,
            (None, None) => None,
        };
    }
    Ok(())
}

/// Plans every change first, so a refusal (a link, a bad hooks document) changes nothing; then
/// writes: the skill before the hooks on install, the hooks first on uninstall.
fn execute(cmd: &Command, env: &Env) -> Result<Report, Error> {
    let layout = layout(cmd.host, env)?;
    let mut notes = Vec::new();
    let command = match cmd.action {
        Action::Install => {
            let (command, note) = program(env)?;
            notes.extend(note);
            Some(command)
        }
        Action::Uninstall => None,
    };
    let (mut hooks, events) = plan_hooks(&layout, cmd, command.as_deref().unwrap_or("mwf"))?;
    let mut skill = plan_skill(&layout, cmd.action)?;
    if !cmd.dry_run {
        match cmd.action {
            Action::Install => {
                skill.iter_mut().try_for_each(apply)?;
                apply(&mut hooks)?;
            }
            Action::Uninstall => {
                apply(&mut hooks)?;
                skill.iter_mut().try_for_each(apply)?;
                for (rel, _) in mwf_assets::SKILL_FILES.iter().rev() {
                    let mut dir = layout.skill_rel.join(rel);
                    while dir.pop() && dir.starts_with(&layout.skill_rel) {
                        fsx::remove_empty_dir(&layout.skill_base, &dir);
                    }
                }
                let dir = layout.skill_base.join(&layout.skill_rel);
                if fs::symlink_metadata(&dir).is_ok() {
                    notes.push(format!(
                        "kept {}: it holds files mwf did not write",
                        dir.display()
                    ));
                }
            }
        }
    }
    let hooks_change = events
        .iter()
        .any(|(_, s)| matches!(s, Status::Added | Status::Updated));
    match (cmd.action, cmd.host) {
        // Unchanged entries stay trusted; only new or changed ones need /hooks (ADR 0024).
        (Action::Install, Host::Codex) if hooks_change => notes.push(
            if cmd.dry_run {
                "Codex runs new or changed hooks only after you trust them: after a real install, run /hooks in Codex and trust the mwf hooks"
            } else {
                "Codex runs new or changed hooks only after you trust them: run /hooks in Codex and trust the mwf hooks"
            }
            .to_owned(),
        ),
        (Action::Install, _) => {}
        (Action::Uninstall, _) => {
            notes.push("project wikis (.mwf/) were not touched".to_owned());
        }
    }
    if cmd.action == Action::Install {
        notes.push(
            "the hooks do nothing in a project until `mwf init` creates its .mwf/".to_owned(),
        );
    }
    Ok(Report {
        action: cmd.action,
        host: cmd.host,
        dry_run: cmd.dry_run,
        command,
        hooks_path: layout.hooks_base.join(&layout.hooks_rel),
        hooks,
        events,
        skill_dir: layout.skill_base.join(&layout.skill_rel),
        skill,
        notes,
    })
}

fn path_json(p: &Path) -> Json {
    Json::str(&p.display().to_string())
}

impl Report {
    fn to_json(&self) -> Json {
        let backup = |b: &Option<PathBuf>| b.as_deref().map_or(Json::Null, path_json);
        let events = Json::object(
            self.events
                .iter()
                .map(|(e, s)| (*e, Json::str(s.as_str())))
                .collect(),
        );
        let hooks = Json::object(vec![
            ("path", path_json(&self.hooks_path)),
            ("status", Json::str(self.hooks.status)),
            ("backup", backup(&self.hooks.backup)),
            ("events", events),
        ]);
        let files = self
            .skill
            .iter()
            .map(|f| {
                Json::object(vec![
                    ("path", Json::str(&f.name)),
                    ("status", Json::str(f.status)),
                    ("backup", backup(&f.backup)),
                ])
            })
            .collect();
        let skill = Json::object(vec![
            ("dir", path_json(&self.skill_dir)),
            ("files", Json::Array(files, Span::default())),
        ]);
        let mut entries = vec![
            ("action", Json::str(self.action.name())),
            ("host", Json::str(self.host.name())),
            ("dry_run", Json::Bool(self.dry_run)),
        ];
        if let Some(c) = &self.command {
            entries.push(("command", Json::str(c)));
        }
        entries.extend([
            ("hooks", hooks),
            ("skill", skill),
            (
                "notes",
                Json::Array(
                    self.notes.iter().map(|n| Json::str(n)).collect(),
                    Span::default(),
                ),
            ),
        ]);
        Json::object(entries)
    }

    fn to_text(&self) -> String {
        let mut out = match (self.action, self.dry_run) {
            (Action::Install, false) => format!("installed mwf for {}\n", self.host.title()),
            (Action::Uninstall, false) => format!("uninstalled mwf from {}\n", self.host.title()),
            (Action::Install, true) => format!(
                "would install mwf for {} (dry run: nothing was written)\n",
                self.host.title()
            ),
            (Action::Uninstall, true) => format!(
                "would uninstall mwf from {} (dry run: nothing was written)\n",
                self.host.title()
            ),
        };
        let backup = |b: &Option<PathBuf>| {
            b.as_ref()
                .map(|b| format!(" (backup: {})", b.display()))
                .unwrap_or_default()
        };
        out += &format!(
            "hooks: {}: {}{}\n",
            self.hooks_path.display(),
            self.hooks.status,
            backup(&self.hooks.backup)
        );
        for (event, status) in &self.events {
            out += &format!("  {event}: {}\n", status.as_str());
        }
        out += &format!("skill: {}\n", self.skill_dir.display());
        for f in &self.skill {
            out += &format!("  {}: {}{}\n", f.name, f.status, backup(&f.backup));
        }
        if let Some(c) = &self.command {
            out += &format!("hook command: {c}\n");
        }
        for n in &self.notes {
            out += &format!("note: {n}\n");
        }
        out
    }
}

#[cfg(test)]
mod tests;
