//! The hook APIs of `mwf-app` against real projects (ADRs 0030, 0034, 0039, 0040, 0051).

#![allow(clippy::unwrap_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};

use mwf_app::{App, ErrorCode, FixedClock, HooksConfig, NewIn, SESSION_LOG_LINES};
use tempfile::TempDir;

/// 2026-11-20T10:00:00Z.
const T0: u64 = 1_795_168_800;
const DAY: u64 = 86_400;

fn secret() -> String {
    ["ghp", "_", "Zq8xK2mN7pR4vT9wB3cD6fG1hJ5kL0sAeYuI"].concat()
}

/// A secret-looking string that is also a valid slug.
fn slug_secret() -> String {
    ["glpat", "-", "zq8xk2mn7pr4vt9wb3cd6fg1"].concat()
}

struct Env {
    _dir: TempDir,
    root: PathBuf,
}

impl Env {
    fn new() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        App::init(&root, false).unwrap();
        Env { _dir: dir, root }
    }

    fn app(&self) -> App {
        self.app_at(T0)
    }

    fn app_at(&self, secs: u64) -> App {
        App::open_with_clock(&self.root, Box::new(FixedClock(secs))).unwrap()
    }

    fn mwf(&self, rel: &str) -> PathBuf {
        self.root.join(".mwf").join(rel)
    }

    fn page(&self, slug: &str, page_type: &str, title: &str, summary: &str, body: &str) {
        self.app()
            .new_page(NewIn {
                slug: slug.into(),
                page_type: page_type.into(),
                title: title.into(),
                summary: summary.into(),
                tags: vec![],
                body: body.into(),
            })
            .unwrap();
    }

    /// A page file written by hand (an editor or a merge), bypassing mwf's checks.
    fn hand_page(&self, stem: &str, page_type: &str, title: &str, summary: &str, body: &str) {
        fs::write(
            self.mwf(&format!("pages/{stem}.md")),
            format!(
                "---\ntitle: {title}\ntype: {page_type}\nsummary: {summary}\nstatus: active\ncreated: 2026-11-20T10:00:00Z\nupdated: 2026-11-20T10:00:00Z\n---\n{body}"
            ),
        )
        .unwrap();
    }

    fn config(&self, text: &str) {
        fs::write(self.mwf("config.toml"), text).unwrap();
    }

    fn state_files(&self) -> Vec<String> {
        let Ok(rd) = fs::read_dir(self.mwf(".state")) else {
            return vec![];
        };
        let mut v: Vec<String> = rd
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }
}

fn slugs(pages: &[mwf_app::PageSummary]) -> Vec<&str> {
    pages.iter().map(|p| p.slug.as_str()).collect()
}

// --- hooks_config ---

#[test]
fn hooks_config_defaults_overrides_and_invalid() {
    let env = Env::new();
    assert_eq!(
        env.app().hooks_config().unwrap(),
        HooksConfig {
            recall_min_terms: 2,
            recall_top_k: 3,
            stop_reminder: true,
            session_start_max_chars: 8000,
        }
    );
    env.config("[hooks]\nrecall_top_k = 1\nstop_reminder = false\n");
    let c = env.app().hooks_config().unwrap();
    assert_eq!(
        (c.recall_top_k, c.stop_reminder, c.recall_min_terms),
        (1, false, 2)
    );
    fs::remove_file(env.mwf("config.toml")).unwrap();
    assert_eq!(env.app().hooks_config().unwrap().recall_top_k, 3);

    let key = secret();
    env.config(&format!("[hooks]\nrecall_top_k = \"{key}\"\n"));
    let err = env.app().hooks_config().unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidConfig);
    assert!(!err.message.contains(&key), "{}", err.message);
    // Every API that reads the config fails the same way.
    assert_eq!(
        env.app().recall("s", "alpha beta").unwrap_err().code,
        ErrorCode::InvalidConfig
    );
    assert_eq!(
        env.app().stop_reminder("s", "t").unwrap_err().code,
        ErrorCode::InvalidConfig
    );
}

// --- session_context ---

#[test]
fn empty_project_has_empty_context() {
    let env = Env::new();
    let ctx = env.app().session_context(8000).unwrap();
    assert_eq!(ctx.text, "");
    assert!(!ctx.truncated);
}

#[test]
fn context_orders_preferences_directory_log_and_lint() {
    let env = Env::new();
    env.page("zz-task", "task", "Ship it", "Release v2", "steps\n");
    env.page(
        "b-style",
        "preference",
        "Style",
        "Code style",
        "Use tabs.\nNo emoji.\n",
    );
    env.page(
        "a-lang",
        "preference",
        "Language",
        "Reply language",
        "Answer in English.\n",
    );
    env.page(
        "use-bm25",
        "decision",
        "Use BM25",
        "Ranking",
        "We rank with BM25.\n",
    );
    env.page("old", "knowledge", "Old", "Archived note", "x\n");
    env.app().archive("old", true).unwrap();
    let ctx = env.app().session_context(8000).unwrap();
    assert!(!ctx.truncated);
    let t = &ctx.text;
    let expected_head = "## Preferences\n\n### Language (a-lang)\nAnswer in English.\n\n### Style (b-style)\nUse tabs.\nNo emoji.\n\n## Directory\n### preference\n- a-lang: Language — Reply language\n- b-style: Style — Code style\n### decision\n- use-bm25: Use BM25 — Ranking\n### task\n- zz-task: Ship it — Release v2\n\n## Recent changes\n";
    assert!(t.starts_with(expected_head), "{t}");
    // Archived pages are not listed; the log shows the archive.
    assert!(!t.contains("- old:"), "{t}");
    assert!(t.contains(" archive old "), "{t}");
    // Every active page is an orphan (warning), so a lint line ends the text.
    assert!(
        t.ends_with("\nlint: 0 errors, 4 warnings; run `mwf lint` for details\n"),
        "{t}"
    );
}

#[test]
fn context_shows_only_the_last_log_lines() {
    let env = Env::new();
    for i in 0..15 {
        env.page(
            &format!("p{i:02}"),
            "knowledge",
            &format!("P{i}"),
            "s",
            "b\n",
        );
    }
    let t = env.app().session_context(100_000).unwrap().text;
    let log = t.split("## Recent changes\n").nth(1).unwrap();
    let lines: Vec<&str> = log.lines().take_while(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), SESSION_LOG_LINES);
    assert!(lines[0].contains(" new p05 "), "{lines:?}");
    assert!(lines[9].contains(" new p14 "), "{lines:?}");
}

#[test]
fn context_lint_line_skips_possible_duplicate_and_shows_errors() {
    let env = Env::new();
    let text = "The deploy pipeline builds the image, runs the canary on staging, waits for health checks, then promotes to production and keeps the previous image for rollback.";
    env.page(
        "deploy",
        "knowledge",
        "Deploy pipeline",
        "Deploy",
        &format!("{text}\n"),
    );
    env.page(
        "deploy-copy",
        "knowledge",
        "Deploy pipeline steps",
        "Deploy",
        &format!("{text} Ask the on-call first.\n"),
    );
    env.page(
        "tabs",
        "preference",
        "Use tabs",
        "Tabs",
        "Indent with tabs in every language.\n",
    );
    let lint = env.app().lint().unwrap();
    let dups = lint
        .issues
        .iter()
        .filter(|i| i.rule == "possible_duplicate")
        .count();
    assert_eq!(dups, 2);
    let t = env.app().session_context(8000).unwrap().text;
    let expected = format!("lint: 0 errors, {} warnings;", lint.warnings - dups);
    assert!(t.contains(&expected), "{t}");

    // An invalid page file is an error.
    fs::write(env.mwf("pages/broken.md"), "no frontmatter").unwrap();
    let t = env.app().session_context(8000).unwrap().text;
    assert!(t.contains("lint: 1 errors, 3 warnings"), "{t}");
}

#[test]
fn context_truncates_whole_lines_with_a_type_hint_and_keeps_lint() {
    let env = Env::new();
    for i in 0..40 {
        env.page(
            &format!("k{i:02}"),
            "knowledge",
            &format!("Knowledge page {i}"),
            "a summary that takes some room",
            "b\n",
        );
    }
    let full = env.app().session_context(100_000).unwrap();
    assert!(!full.truncated);
    let max = 1200;
    let ctx = env.app().session_context(max).unwrap();
    assert!(ctx.truncated);
    assert!(
        ctx.text.chars().count() <= max,
        "{}",
        ctx.text.chars().count()
    );
    assert!(
        ctx.text.contains(
            "[mwf: truncated; run `mwf index` for the whole directory or `mwf list --type knowledge` for this type]\n"
        ),
        "{}",
        ctx.text
    );
    assert!(
        ctx.text.ends_with("run `mwf lint` for details\n"),
        "{}",
        ctx.text
    );
    // Whole lines only: every directory line kept is a line of the full text.
    for l in ctx.text.lines().filter(|l| l.starts_with("- ")) {
        assert!(full.text.contains(&format!("{l}\n")), "{l}");
    }
    assert!(!ctx.text.contains("## Recent changes"));
    // Every budget is respected, including one too small for the hint.
    for max in [0, 5, 50, 300, 2000] {
        let c = env.app().session_context(max).unwrap();
        assert!(c.truncated);
        assert!(c.text.chars().count() <= max, "max {max}");
    }
}

#[test]
fn context_cut_in_preferences_names_list_type_preference() {
    let env = Env::new();
    let long = "A rule we always follow.\n".repeat(60);
    env.page("rules", "preference", "Rules", "House rules", &long);
    let ctx = env.app().session_context(600).unwrap();
    assert!(ctx.truncated);
    assert!(
        ctx.text
            .starts_with("## Preferences\n\n### Rules (rules)\nA rule")
    );
    assert!(
        ctx.text
            .contains("run `mwf list --type preference` and `mwf show <slug>`"),
        "{}",
        ctx.text
    );
    assert!(ctx.text.chars().count() <= 600);
}

#[test]
fn context_counts_characters_not_bytes() {
    let env = Env::new();
    env.page(
        "zh",
        "preference",
        "中文",
        "用中文回答",
        &"用中文回答问题。\n".repeat(20),
    );
    let full = env.app().session_context(100_000).unwrap().text;
    let chars = full.chars().count();
    assert!(full.len() > chars);
    let exact = env.app().session_context(chars).unwrap();
    assert!(!exact.truncated);
    assert_eq!(exact.text, full);
    assert!(env.app().session_context(chars - 1).unwrap().truncated);
}

#[test]
fn context_withholds_secrets() {
    let env = Env::new();
    let key = secret();
    env.hand_page(
        "token-pref",
        "preference",
        "Token",
        "Deploy token",
        &format!("Use {key} to deploy.\n"),
    );
    env.hand_page(
        "titled",
        "knowledge",
        &format!("t {key}"),
        &format!("s {key}"),
        "b\n",
    );
    env.hand_page(
        &format!("{}-x", slug_secret()),
        "knowledge",
        "Secret slug",
        "s",
        "b\n",
    );
    fs::write(
        env.mwf("log.md"),
        format!("2026-11-20T10:00:00Z new titled \"{key}\"\n"),
    )
    .unwrap();
    let t = env.app().session_context(100_000).unwrap().text;
    assert!(!t.contains(&key), "{t}");
    assert!(!t.contains(&slug_secret()), "{t}");
    assert!(
        t.contains("[body withheld: looks like a secret; run `mwf lint`]"),
        "{t}"
    );
    assert!(t.contains("- titled: [title withheld: looks like a secret] — [summary withheld: looks like a secret]"), "{t}");
    assert!(
        t.contains("[log line withheld: looks like a secret]"),
        "{t}"
    );
    assert!(!t.contains("Secret slug"), "{t}");
    assert!(t.contains("lint: "), "{t}");
}

// --- recall ---

fn recall_corpus() -> Env {
    let env = Env::new();
    env.page(
        "canary",
        "decision",
        "Canary deploy",
        "Roll out to staging first",
        "canary rollout staging production\n",
    );
    env.page(
        "rollback",
        "incident",
        "Rollback broke",
        "Rollback of canary failed",
        "rollback canary staging\n",
    );
    env.page(
        "tabs",
        "preference",
        "Tabs",
        "Indent with tabs",
        "tabs indentation\n",
    );
    env.page(
        "staging-db",
        "knowledge",
        "Staging database",
        "Where staging data lives",
        "staging postgres\n",
    );
    env.page(
        "old-canary",
        "decision",
        "Old canary",
        "Canary before 2020",
        "canary rollout staging production\n",
    );
    env.app().archive("old-canary", true).unwrap();
    env
}

#[test]
fn recall_needs_min_terms_and_ranks_active_pages() {
    let env = recall_corpus();
    let app = env.app();
    // `staging-db` contains only "staging"; archived `old-canary` never takes part.
    let hits = app
        .recall("", "how does the canary rollout reach staging?")
        .unwrap();
    assert_eq!(slugs(&hits), ["canary", "rollback"]);
    assert!(!hits[0].rev.is_empty());
    // A one-term prompt returns nothing even though pages match it.
    assert!(app.recall("", "canary").unwrap().is_empty());
    assert!(app.recall("", "canary canary CANARY").unwrap().is_empty());
    // Stopwords do not count as terms.
    assert!(app.recall("", "the canary of").unwrap().is_empty());
    assert!(app.recall("", "").unwrap().is_empty());
}

#[test]
fn recall_follows_min_terms_and_top_k_config() {
    let env = recall_corpus();
    env.config("[hooks]\nrecall_min_terms = 1\nrecall_top_k = 2\n");
    let hits = env.app().recall("", "canary staging").unwrap();
    assert_eq!(hits.len(), 2);
    env.config("[hooks]\nrecall_min_terms = 3\n");
    let hits = env.app().recall("", "canary rollout staging").unwrap();
    assert_eq!(slugs(&hits), ["canary"]);
    env.config("[hooks]\nrecall_top_k = 0\n");
    assert!(
        env.app()
            .recall("s", "canary rollout staging")
            .unwrap()
            .is_empty()
    );
    assert!(env.state_files().is_empty());
}

#[test]
fn recall_returns_each_page_once_per_session() {
    let env = recall_corpus();
    env.config("[hooks]\nrecall_top_k = 1\n");
    let app = env.app();
    let prompt = "canary rollout staging";
    assert_eq!(slugs(&app.recall("s1", prompt).unwrap()), ["canary"]);
    // The next-best page fills the slot once the best was shown.
    assert_eq!(slugs(&app.recall("s1", prompt).unwrap()), ["rollback"]);
    assert!(app.recall("s1", prompt).unwrap().is_empty());
    // Another session, and a later process of the same session.
    assert_eq!(slugs(&app.recall("s2", prompt).unwrap()), ["canary"]);
    assert!(env.app().recall("s1", prompt).unwrap().is_empty());
    assert_eq!(env.state_files(), ["s1.json", "s2.json"]);
    // No session id: no dedupe, no state.
    assert_eq!(slugs(&app.recall("", prompt).unwrap()), ["canary"]);
    assert_eq!(slugs(&app.recall("../", prompt).unwrap()), ["canary"]);
    assert_eq!(env.state_files(), ["s1.json", "s2.json"]);
    // Clearing the session shows the pages again.
    app.reset_session("s1").unwrap();
    assert_eq!(slugs(&app.recall("s1", prompt).unwrap()), ["canary"]);
}

#[test]
fn recall_with_nothing_found_writes_no_state() {
    let env = recall_corpus();
    assert!(
        env.app()
            .recall("s", "unrelated words entirely")
            .unwrap()
            .is_empty()
    );
    assert!(env.state_files().is_empty());
}

#[test]
fn recall_corrupt_state_is_empty() {
    let env = recall_corpus();
    let app = env.app();
    app.recall("s", "canary rollout staging").unwrap();
    fs::write(env.mwf(".state/s.json"), "{garbage").unwrap();
    assert_eq!(
        slugs(&app.recall("s", "canary rollout staging").unwrap()),
        ["canary", "rollback"]
    );
}

#[cfg(unix)]
#[test]
fn recall_with_symlinked_state_dir_is_wrong_file_type() {
    let env = recall_corpus();
    let outside = env.root.join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, env.mwf(".state")).unwrap();
    let err = env.app().recall("s", "canary rollout staging").unwrap_err();
    assert_eq!(err.code, ErrorCode::WrongFileType);
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
}

#[test]
fn recall_withholds_secret_metadata_and_slugs() {
    let env = Env::new();
    let key = secret();
    env.hand_page(
        "leaky",
        "knowledge",
        &format!("canary {key}"),
        &format!("staging {key}"),
        "canary staging\n",
    );
    let slug_key = format!("{}-canary", slug_secret());
    env.hand_page(
        &slug_key,
        "knowledge",
        "canary staging",
        "canary staging",
        "canary staging\n",
    );
    let hits = env.app().recall("s", "canary staging").unwrap();
    assert_eq!(slugs(&hits), ["leaky"]);
    assert_eq!(hits[0].title, "[title withheld: looks like a secret]");
    assert_eq!(hits[0].summary, "[summary withheld: looks like a secret]");
}

#[test]
fn sessions_a_week_old_are_pruned_on_use() {
    let env = recall_corpus();
    // State files get the real mtime; a clock 8 days ahead makes them old.
    env.app().recall("old", "canary rollout staging").unwrap();
    assert_eq!(env.state_files(), ["old.json"]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    env.app_at(now + 6 * DAY)
        .recall("new", "canary rollout staging")
        .unwrap();
    assert_eq!(env.state_files(), ["new.json", "old.json"]);
    env.app_at(now + 8 * DAY)
        .recall("newer", "canary rollout staging")
        .unwrap();
    assert_eq!(env.state_files(), ["newer.json"]);
}

// --- stop_reminder ---

#[test]
fn stop_reminds_once_per_turn() {
    let env = Env::new();
    let app = env.app();
    assert!(app.stop_reminder("s", "turn-1").unwrap());
    assert!(!app.stop_reminder("s", "turn-1").unwrap());
    assert!(app.stop_reminder("s", "turn-2").unwrap());
    assert!(app.stop_reminder("other", "turn-2").unwrap());
    // Without a turn or a session there is nothing to remember it by.
    assert!(app.stop_reminder("s", "").unwrap());
    assert!(app.stop_reminder("s", "").unwrap());
    assert!(app.stop_reminder("", "turn-9").unwrap());
    assert!(app.stop_reminder("", "turn-9").unwrap());
    // Recall and the reminder share the session file.
    env.page("a", "knowledge", "Canary deploy", "staging canary", "b\n");
    app.recall("s", "canary staging").unwrap();
    assert!(!app.stop_reminder("s", "turn-2").unwrap());

    env.config("[hooks]\nstop_reminder = false\n");
    assert!(!env.app().stop_reminder("s", "turn-3").unwrap());
}

// --- is_inside_mwf ---

#[test]
fn inside_mwf_resolves_relative_and_dotted_paths() {
    let env = Env::new();
    let app = env.app();
    let root = &env.root;
    let inside = |cwd: &Path, p: &str| app.is_inside_mwf(cwd, Path::new(p));
    assert!(inside(root, ".mwf/pages/a.md"));
    assert!(inside(root, ".mwf/index.md"));
    assert!(inside(root, ".mwf"));
    assert!(inside(root, &format!("{}/.mwf/log.md", root.display())));
    assert!(inside(&root.join("src"), "../.mwf/pages/new.md"));
    assert!(inside(root, "src/../.mwf/pages/x.md"));
    assert!(!inside(root, ".mwf/../src/main.rs"));
    assert!(!inside(root, "src/main.rs"));
    assert!(!inside(root, ".mwf-notes/a.md"));
    assert!(!inside(root, "docs/x.mwf"));
    // Not yet existing files and directories.
    assert!(inside(root, ".mwf/pages/new/deeper/x.md"));
    assert!(!inside(root, "nope/also/x.md"));
    // Any `.mwf`, such as a nested project or another checkout.
    assert!(inside(root, "vendor/lib/.mwf/pages/a.md"));
    assert!(inside(root, "/elsewhere/.mwf/pages/a.md"));
}

#[cfg(unix)]
#[test]
fn inside_mwf_follows_symlinks_including_dangling_ones() {
    use std::os::unix::fs::symlink;
    let env = Env::new();
    let app = env.app();
    let root = &env.root;
    symlink(".mwf/pages", root.join("notes")).unwrap();
    symlink(root.join(".mwf"), root.join("mem")).unwrap();
    symlink(".mwf/pages/missing.md", root.join("dangling.md")).unwrap();
    fs::create_dir(root.join("src")).unwrap();
    symlink("../.mwf", root.join("src/up")).unwrap();
    symlink("loop", root.join("loop")).unwrap();
    symlink(root.join("src"), root.join(".mwf/pages/out")).unwrap();
    let inside = |p: &str| app.is_inside_mwf(root, Path::new(p));
    assert!(inside("notes/a.md"));
    assert!(inside("mem/log.md"));
    assert!(inside("dangling.md"));
    assert!(inside("src/up/pages/a.md"));
    assert!(inside("notes/new-dir/x.md"));
    assert!(!inside("loop/x.md"));
    // A link inside .mwf/ pointing out of it is not inside.
    assert!(!inside(".mwf/pages/out/main.rs"));
    // Through a symlinked cwd.
    assert!(app.is_inside_mwf(&root.join("mem"), Path::new("pages/a.md")));
}
