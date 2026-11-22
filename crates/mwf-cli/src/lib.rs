//! Command-line adapter: argument parsing, calling `mwf-app`, text and `--json` output, exit codes.
//!
//! See [docs/crates/adapters.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/adapters.md)
//! and ADR 0050 for the output formats.

mod args;
mod render;

use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use mwf_app::{
    App, AppError, ErrorCode, ListIn, NewIn, PatchIn, SearchIn, SetIn, StatusFilter, WriteIn,
};
use serde_json::{Value, json};

use args::{Cli, Command};

/// The most `mwf` reads from stdin or a `--old-file` / `--new-file` (ADR 0033), in bytes.
pub const STDIN_MAX_BYTES: u64 = 1024 * 1024;

/// The standard streams of one run; tests can pass buffers.
pub struct Io<'a> {
    pub stdin: &'a mut dyn Read,
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
}

/// Runs one command line (`args[0]` is the program name) in the current directory and returns
/// the exit code: 0 success, 1 the operation failed (or `lint` found an error), 2 usage error.
pub fn run(args: Vec<OsString>, io: &mut Io) -> ExitCode {
    // Read before parsing, so usage errors are JSON too; `--` ends the options.
    let json = args
        .iter()
        .skip(1)
        .take_while(|a| *a != "--")
        .any(|a| a == "--json");
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(e) => return usage(&e, json, io),
    };
    let result = execute(cli.command, io.stdin);
    let (out, code) = match result {
        Ok(ok) => {
            let text = if cli.json {
                envelope_ok(&ok.data)
            } else {
                ok.text
            };
            (text, ok.exit)
        }
        Err(f) => {
            if cli.json {
                (envelope_err(&f), 1)
            } else {
                let _ = writeln!(io.stderr, "error[{}]: {}", f.code, f.message);
                return ExitCode::from(1);
            }
        }
    };
    if io.stdout.write_all(out.as_bytes()).is_err() || io.stdout.flush().is_err() {
        return ExitCode::from(1);
    }
    ExitCode::from(code)
}

/// A clap error: `--help` and `--version` print to stdout and exit 0, everything else is
/// `USAGE` and exits 2.
fn usage(e: &clap::Error, json: bool, io: &mut Io) -> ExitCode {
    let text = e.render().to_string();
    if !e.use_stderr() {
        let _ = io.stdout.write_all(text.as_bytes());
        return ExitCode::SUCCESS;
    }
    if json {
        let message = text.trim().strip_prefix("error: ").unwrap_or(text.trim());
        let f = Failure {
            code: "USAGE",
            message: message.to_owned(),
            details: Value::Null,
        };
        let _ = io.stdout.write_all(envelope_err(&f).as_bytes());
    } else {
        let _ = io.stderr.write_all(text.as_bytes());
    }
    ExitCode::from(2)
}

/// A failed command: an `mwf-app` error, or one of the CLI's own (stdin too large, …).
struct Failure {
    code: &'static str,
    message: String,
    details: Value,
}

impl From<AppError> for Failure {
    fn from(e: AppError) -> Failure {
        Failure {
            code: e.code.as_str(),
            message: e.message,
            details: e.details,
        }
    }
}

/// A command's result: the `--json` data (serialized), the text output, and the exit code.
struct Done {
    data: String,
    text: String,
    exit: u8,
}

/// `data` is the `mwf-app` result serialized as it is, in field order (ADR 0050).
fn done(data: serde_json::Result<String>, text: String) -> Result<Done, Failure> {
    let data = data.map_err(|e| Failure {
        code: ErrorCode::Io.as_str(),
        message: format!("cannot serialize the result: {e}"),
        details: Value::Null,
    })?;
    Ok(Done {
        data,
        text,
        exit: 0,
    })
}

// Written by hand: a `serde_json::Value` would sort the keys, putting `ok` last.
fn envelope_ok(data: &str) -> String {
    format!("{{\"ok\":true,\"data\":{data}}}\n")
}

fn envelope_err(f: &Failure) -> String {
    let details = if f.details.is_null() {
        String::new()
    } else {
        format!(",\"details\":{}", f.details)
    };
    format!(
        "{{\"ok\":false,\"error\":{{\"code\":{},\"message\":{}{details}}}}}\n",
        Value::from(f.code),
        Value::from(f.message.as_str())
    )
}

fn execute(command: Command, stdin: &mut dyn Read) -> Result<Done, Failure> {
    let cwd = std::env::current_dir().map_err(|e| Failure {
        code: ErrorCode::Io.as_str(),
        message: format!("cannot read the current directory: {e}"),
        details: Value::Null,
    })?;
    let open = || App::open(&cwd).map_err(Failure::from);
    match command {
        Command::Init { local } => {
            let out = App::init(&cwd, local)?;
            done(serde_json::to_string(&out), out.next_steps.to_owned())
        }
        Command::Show { slug } => {
            let page = open()?.show(&slug)?;
            done(serde_json::to_string(&page), render::page(&page))
        }
        Command::Search {
            query,
            filter,
            limit,
        } => {
            let hits = open()?.search(&SearchIn {
                query: query.join(" "),
                types: filter.types,
                tags: filter.tags,
                status: StatusFilter::from(filter.status),
                limit,
            })?;
            done(serde_json::to_string(&hits), render::hits(&hits))
        }
        Command::List { filter } => {
            let pages = open()?.list(&ListIn {
                types: filter.types,
                tags: filter.tags,
                status: StatusFilter::from(filter.status),
            })?;
            done(serde_json::to_string(&pages), render::summaries(&pages))
        }
        Command::Index { rebuild } => {
            let text = open()?.index(rebuild)?;
            done(serde_json::to_string(&text), text.clone())
        }
        Command::Log { n } => {
            let lines = open()?.log(n)?;
            done(serde_json::to_string(&lines), render::lines(&lines))
        }
        Command::Lint => {
            let report = open()?.lint()?;
            let mut d = done(serde_json::to_string(&report), render::lint(&report))?;
            d.exit = u8::from(report.errors > 0);
            Ok(d)
        }
        Command::New {
            slug,
            page_type,
            title,
            summary,
            tags,
        } => {
            let app = open()?;
            let body = read_limited(stdin, "stdin")?;
            let out = app.new_page(NewIn {
                slug,
                page_type,
                title,
                summary,
                tags,
                body,
            })?;
            done(serde_json::to_string(&out), render::write("created", &out))
        }
        Command::Write { slug, rev } => {
            let app = open()?;
            let body = read_limited(stdin, "stdin")?;
            let out = app.write(WriteIn { slug, rev, body })?;
            done(serde_json::to_string(&out), render::write("updated", &out))
        }
        Command::Patch {
            slug,
            old,
            old_file,
            new,
            new_file,
        } => {
            let out = open()?.patch(PatchIn {
                slug,
                old: text_or_file(old, old_file.as_deref(), "--old-file")?,
                new: text_or_file(new, new_file.as_deref(), "--new-file")?,
            })?;
            done(serde_json::to_string(&out), render::write("updated", &out))
        }
        Command::Set {
            slug,
            title,
            page_type,
            summary,
            add_tags,
            remove_tags,
        } => {
            let out = open()?.set(SetIn {
                slug,
                title,
                page_type,
                summary,
                add_tags,
                remove_tags,
            })?;
            done(serde_json::to_string(&out), render::write("updated", &out))
        }
        Command::Archive { slug } => {
            let out = open()?.archive(&slug, true)?;
            done(serde_json::to_string(&out), render::write("archived", &out))
        }
        Command::Unarchive { slug } => {
            let out = open()?.archive(&slug, false)?;
            done(
                serde_json::to_string(&out),
                render::write("unarchived", &out),
            )
        }
        Command::Rename { old, new } => {
            let out = open()?.rename(&old, &new)?;
            done(
                serde_json::to_string(&out),
                render::write(&format!("renamed {old} ->"), &out),
            )
        }
        Command::Delete { slug, unlink } => {
            let out = open()?.delete(&slug, unlink)?;
            done(serde_json::to_string(&out), render::delete(&out))
        }
    }
}

/// The `--old` / `--new` text, or the contents of its `--*-file` (clap requires one of them).
fn text_or_file(text: Option<String>, file: Option<&Path>, flag: &str) -> Result<String, Failure> {
    match (text, file) {
        (Some(t), _) => Ok(t),
        (None, Some(path)) => {
            let mut f = File::open(path).map_err(|e| Failure {
                code: ErrorCode::Io.as_str(),
                message: format!("cannot read {flag} {}: {e}", path.display()),
                details: json!({ "path": path.display().to_string() }),
            })?;
            read_limited(&mut f, flag)
        }
        (None, None) => Ok(String::new()),
    }
}

/// Reads UTF-8 text, failing with `TOO_LARGE` as soon as more than [`STDIN_MAX_BYTES`] arrive
/// (ADR 0033) instead of reading the rest.
fn read_limited(input: &mut dyn Read, what: &str) -> Result<String, Failure> {
    let mut bytes = Vec::new();
    input
        .take(STDIN_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Failure {
            code: ErrorCode::Io.as_str(),
            message: format!("cannot read {what}: {e}"),
            details: Value::Null,
        })?;
    if bytes.len() as u64 > STDIN_MAX_BYTES {
        return Err(Failure {
            code: ErrorCode::TooLarge.as_str(),
            message: format!("{what} is larger than {STDIN_MAX_BYTES} bytes (1 MB)"),
            details: json!({ "field": what, "limit": STDIN_MAX_BYTES }),
        });
    }
    String::from_utf8(bytes).map_err(|_| Failure {
        code: ErrorCode::InvalidField.as_str(),
        message: format!("{what} is not UTF-8"),
        details: json!({ "field": what }),
    })
}
