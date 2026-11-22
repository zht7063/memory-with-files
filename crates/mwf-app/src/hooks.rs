//! What the hooks ask of the project (ADRs 0024, 0030, 0034, 0039, 0040, 0051): the
//! SessionStart context, prompt recall with once-per-session dedupe, the once-per-turn Stop
//! reminder, and the PreToolUse path check. Host formats, fences and budgets belong to
//! `mwf-hooks`.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use mwf_domain::{Page, PageType, Status};
use mwf_search::{Index, tokenize};
use mwf_store::SessionStore;

use crate::corpus::{Corpus, doc};
use crate::dto::{HooksConfig, PageSummary, SessionContext};
use crate::error::AppError;
use crate::read::page_summary;
use crate::{App, redact};

/// `log.md` lines SessionStart shows (ADR 0030).
pub const SESSION_LOG_LINES: usize = 10;
/// Distinct terms a prompt needs before `recall` searches at all (ADR 0039: a one-term prompt
/// injects nothing, whatever `recall_min_terms` says).
pub const RECALL_MIN_PROMPT_TERMS: usize = 2;

const WITHHELD_BODY: &str = "[body withheld: looks like a secret; run `mwf lint`]";
const WITHHELD_LOG: &str = "[log line withheld: looks like a secret]";
/// Symlinks followed while resolving one path before giving up (as Linux's `MAXSYMLINKS`).
const MAX_SYMLINKS: u32 = 40;

/// Where the SessionStart text was cut, which decides the hint.
#[derive(Clone, Copy)]
enum Part {
    Preferences,
    Directory(Option<PageType>),
    Log,
}

impl Part {
    fn hint(self) -> String {
        match self {
            Part::Preferences => "[mwf: truncated; run `mwf list --type preference` and `mwf show <slug>` for the other preferences, `mwf index` for the directory]".to_owned(),
            Part::Directory(None) => "[mwf: truncated; run `mwf index` for the directory]".to_owned(),
            Part::Directory(Some(t)) => format!(
                "[mwf: truncated; run `mwf index` for the whole directory or `mwf list --type {}` for this type]",
                t.as_str()
            ),
            Part::Log => "[mwf: truncated; run `mwf log` for recent changes]".to_owned(),
        }
    }
}

/// Characters a line takes in the output, with its newline.
fn width(line: &str) -> usize {
    line.chars().count() + 1
}

/// Joins `lines` and `tail` within `max` characters. When everything does not fit, keeps the
/// longest prefix of `lines` that fits together with the hint of the first line left out and
/// with `tail`; whole lines only.
fn fit(lines: &[(Part, String)], tail: &[String], max: usize) -> SessionContext {
    let tail_width: usize = tail.iter().map(|l| width(l)).sum();
    let total: usize = lines.iter().map(|(_, l)| width(l)).sum::<usize>() + tail_width;
    let mut out = String::new();
    let join = |out: &mut String, ls: &mut dyn Iterator<Item = &String>| {
        for l in ls {
            out.push_str(l);
            out.push('\n');
        }
    };
    if total <= max {
        join(&mut out, &mut lines.iter().map(|(_, l)| l));
        join(&mut out, &mut tail.iter());
        return SessionContext {
            text: out,
            truncated: false,
        };
    }
    let mut keep = None;
    let mut prefix = 0;
    for (i, (part, line)) in lines.iter().enumerate() {
        if prefix + width(&part.hint()) + tail_width <= max {
            keep = Some(i);
        }
        prefix += width(line);
    }
    let cut = keep.unwrap_or(0);
    join(&mut out, &mut lines[..cut].iter().map(|(_, l)| l));
    let hint = lines.get(cut).map_or(Part::Log, |(p, _)| *p).hint();
    out.push_str(&hint);
    out.push('\n');
    join(&mut out, &mut tail.iter());
    // Only when even the hint and tail do not fit in `max`.
    if out.chars().count() > max {
        out = out.chars().take(max).collect();
    }
    SessionContext {
        text: out,
        truncated: true,
    }
}

impl App {
    /// The `[hooks]` settings; an invalid `config.toml` is `INVALID_CONFIG` (ADR 0049).
    pub fn hooks_config(&self) -> Result<HooksConfig, AppError> {
        let h = self.project.config()?.hooks;
        Ok(HooksConfig {
            recall_min_terms: h.recall_min_terms,
            recall_top_k: h.recall_top_k,
            stop_reminder: h.stop_reminder,
            session_start_max_chars: h.session_start_max_chars,
        })
    }

    /// The SessionStart injection, at most `max_chars` characters (ADRs 0030, 0040, 0051):
    ///
    /// 1. `## Preferences`: the body of every active `preference` page, by slug;
    /// 2. `## Directory`: one line per active page, grouped by type in `PageType::ALL` order and
    ///    sorted by slug, rendered from the pages (not from a possibly stale `index.md`);
    /// 3. `## Recent changes`: the last [`SESSION_LOG_LINES`] lines of `log.md`;
    /// 4. one line counting lint findings, when there are any. It runs every rule except
    ///    `possible_duplicate`, which needs a BM25 query per page.
    ///
    /// When it does not fit, whole lines are dropped from the end of 1–3 and a hint naming the
    /// command for the rest takes their place; the lint line is always kept. Pages whose slug
    /// looks like a secret are left out, and secret-looking titles, summaries, preference
    /// bodies and log lines are withheld, as in `index.md` (ADR 0049).
    pub fn session_context(&self, max_chars: usize) -> Result<SessionContext, AppError> {
        let corpus = Corpus::load(&self.project)?;
        let active: Vec<&Page> = corpus
            .pages()
            .filter(|p| p.fm.status == Status::Active && !redact::looks_secret(p.slug.as_str()))
            .collect();
        let mut lines: Vec<(Part, String)> = Vec::new();

        let prefs: Vec<&&Page> = active
            .iter()
            .filter(|p| p.fm.page_type == PageType::Preference)
            .collect();
        if !prefs.is_empty() {
            let part = Part::Preferences;
            lines.push((part, "## Preferences".to_owned()));
            for p in prefs {
                lines.push((part, String::new()));
                lines.push((
                    part,
                    format!("### {} ({})", redact::title(&p.fm.title), p.slug),
                ));
                if redact::looks_secret(&p.body) {
                    lines.push((part, WITHHELD_BODY.to_owned()));
                } else {
                    for l in p.body.trim_end().lines() {
                        lines.push((part, l.to_owned()));
                    }
                }
            }
        }

        if !active.is_empty() {
            if !lines.is_empty() {
                lines.push((Part::Directory(None), String::new()));
            }
            lines.push((Part::Directory(None), "## Directory".to_owned()));
            for t in PageType::ALL {
                let part = Part::Directory(Some(t));
                // `corpus` is sorted by name, so each group is sorted by slug.
                let group: Vec<&&Page> = active.iter().filter(|p| p.fm.page_type == t).collect();
                if group.is_empty() {
                    continue;
                }
                lines.push((part, format!("### {}", t.as_str())));
                for p in group {
                    lines.push((
                        part,
                        format!(
                            "- {}: {} — {}",
                            p.slug,
                            redact::title(&p.fm.title),
                            redact::summary(&p.fm.summary)
                        ),
                    ));
                }
            }
        }

        let log = self.project.read_log(SESSION_LOG_LINES)?;
        if !log.is_empty() {
            if !lines.is_empty() {
                lines.push((Part::Log, String::new()));
            }
            lines.push((Part::Log, "## Recent changes".to_owned()));
            for l in log {
                let shown = if redact::looks_secret(&l) {
                    WITHHELD_LOG.to_owned()
                } else {
                    l
                };
                lines.push((Part::Log, shown));
            }
        }

        let report = self.check(&corpus, false)?;
        let mut tail = Vec::new();
        if report.errors + report.warnings > 0 {
            if !lines.is_empty() {
                tail.push(String::new());
            }
            tail.push(format!(
                "lint: {} errors, {} warnings; run `mwf lint` for details",
                report.errors, report.warnings
            ));
        }
        Ok(fit(&lines, &tail, max_chars))
    }

    /// Pages to inject for a user prompt (ADRs 0030, 0039): BM25 over active pages, keeping
    /// those that contain at least `recall_min_terms` distinct prompt terms, best first, at most
    /// `recall_top_k`, leaving out pages already returned in this session. A prompt with fewer
    /// than [`RECALL_MIN_PROMPT_TERMS`] distinct terms returns nothing.
    ///
    /// The returned pages are recorded in the session's state; a `session` id with no safe
    /// characters (missing in the host input) skips the dedupe. Pages with a secret-looking
    /// slug are never returned, and secret-looking titles and summaries are withheld.
    pub fn recall(&self, session: &str, prompt: &str) -> Result<Vec<PageSummary>, AppError> {
        let cfg = self.hooks_config()?;
        let terms: HashSet<String> = tokenize(prompt).into_iter().collect();
        if terms.len() < RECALL_MIN_PROMPT_TERMS || cfg.recall_top_k == 0 {
            return Ok(Vec::new());
        }
        let store = self.open_session(session);
        let mut state = match &store {
            Some(s) => s.load()?,
            None => Default::default(),
        };
        let corpus = Corpus::load(&self.project)?;
        let active: Vec<&Page> = corpus
            .pages()
            .filter(|p| p.fm.status == Status::Active && !redact::looks_secret(p.slug.as_str()))
            .collect();
        let index = Index::build(active.iter().map(|p| doc(p)));
        let out: Vec<PageSummary> = index
            .search(prompt, active.len())
            .into_iter()
            .filter(|h| h.matched_terms >= cfg.recall_min_terms)
            .filter(|h| !state.recalled.contains(&h.id))
            .take(cfg.recall_top_k)
            .filter_map(|h| corpus.entry(&h.id)?.page.as_ref())
            .map(|p| {
                let mut s = page_summary(&corpus, p);
                s.title = redact::title(&s.title).to_owned();
                s.summary = redact::summary(&s.summary).to_owned();
                s
            })
            .collect();
        if let Some(store) = &store
            && !out.is_empty()
        {
            state.recalled.extend(out.iter().map(|p| p.slug.clone()));
            store.save(&state)?;
        }
        Ok(out)
    }

    /// Whether the Stop hook should remind the agent now (ADRs 0030, 0051): never when
    /// `stop_reminder` is off; otherwise once per host turn (Claude `prompt_id`, Codex
    /// `turn_id`), recorded in the session's state. Without a usable session id or turn id it
    /// says yes; the host's `stop_hook_active` flag, checked by `mwf-hooks`, still prevents a
    /// loop.
    pub fn stop_reminder(&self, session: &str, turn: &str) -> Result<bool, AppError> {
        if !self.hooks_config()?.stop_reminder {
            return Ok(false);
        }
        let Some(store) = self.open_session(session) else {
            return Ok(true);
        };
        if turn.is_empty() {
            return Ok(true);
        }
        let mut state = store.load()?;
        if state.reminded_turn.as_deref() == Some(turn) {
            return Ok(false);
        }
        state.reminded_turn = Some(turn.to_owned());
        store.save(&state)?;
        Ok(true)
    }

    /// Forgets what a session was shown, for SessionStart after `clear` or `compact`: the
    /// agent's context no longer holds the earlier injections (ADR 0051).
    pub fn reset_session(&self, session: &str) -> Result<(), AppError> {
        match self.open_session(session) {
            Some(store) => Ok(store.remove()?),
            None => Ok(()),
        }
    }

    /// The session's state file, after removing state files a week old (ADR 0034). Pruning is
    /// optional upkeep: its failures are ignored, and a broken `.state/` is reported by the
    /// load or save that follows.
    fn open_session(&self, session: &str) -> Option<SessionStore<'_>> {
        let now = UNIX_EPOCH + Duration::from_secs(self.clock.now_unix_secs());
        let _ = self.project.prune_sessions(now);
        self.project.session(session)
    }

    /// Whether writing `path` would bypass mwf (ADR 0024): whether it lies in a `.mwf`
    /// directory, this project's or any other. A relative `path` is taken from `cwd` (the hook
    /// input's working directory). `.` and `..` are resolved and every symlink along the way is
    /// followed, including dangling ones and those below a not-yet-existing directory, so
    /// `link/x.md` with `link -> .mwf/pages` is inside while `.mwf/../src/x.md` is not.
    pub fn is_inside_mwf(&self, cwd: &Path, path: &Path) -> bool {
        let joined = cwd.join(path);
        let start = std::path::absolute(&joined).unwrap_or(joined);
        resolve(&start, 0)
            .components()
            .any(|c| c.as_os_str() == ".mwf")
    }
}

/// `path` with `.`, `..` and every existing symlink resolved, without requiring the path to
/// exist. Components after the first missing one are kept as written (minus `.` and `..`).
fn resolve(path: &Path, depth: u32) -> PathBuf {
    let mut cur = PathBuf::new();
    let mut rest = path.components();
    while let Some(c) = rest.next() {
        match c {
            Component::Prefix(_) | Component::RootDir => cur.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                cur.pop();
            }
            Component::Normal(name) => {
                let next = cur.join(name);
                let is_link = fs::symlink_metadata(&next).is_ok_and(|m| m.file_type().is_symlink());
                if is_link
                    && depth < MAX_SYMLINKS
                    && let Ok(target) = fs::read_link(&next)
                {
                    // A relative target is relative to the link's directory, `cur`.
                    let mut redirected = cur.join(target);
                    redirected.push(rest.as_path());
                    return resolve(&redirected, depth + 1);
                }
                cur = next;
            }
        }
    }
    cur
}
