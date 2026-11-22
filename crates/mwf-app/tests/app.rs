//! Integration tests of `mwf-app` against real project directories.

// Tests may unwrap and panic (ADR 0043); clippy.toml's test exemption does not reach the
// helper functions of an integration test crate.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mwf_app::{
    App, AppError, BODY_MAX_BYTES, ErrorCode, FixedClock, ListIn, NewIn, PatchIn, SearchIn, SetIn,
    Severity, StatusFilter, WriteIn, WriteOut,
};
use tempfile::TempDir;

/// 2026-11-20T10:00:00Z.
const T0: u64 = 1_795_168_800;
const DAY: u64 = 86_400;

/// A secret assembled at run time so the source holds no literal credential.
fn secret() -> String {
    ["ghp", "_", "Zq8xK2mN7pR4vT9wB3cD6fG1hJ5kL0sAeYuI"].concat()
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

    fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.mwf(rel)).unwrap()
    }

    fn page_file(&self, slug: &str) -> String {
        self.read(&format!("pages/{slug}.md"))
    }

    fn log(&self) -> Vec<String> {
        self.read("log.md").lines().map(str::to_owned).collect()
    }

    /// Everything under `.mwf/` except the lock file, for "nothing changed" checks.
    fn snapshot(&self) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for e in fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                let rel = p.strip_prefix(base).unwrap().display().to_string();
                if p.is_dir() {
                    walk(&p, base, out);
                } else if rel != ".lock" {
                    out.push((rel, fs::read(&p).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        let base = self.mwf("");
        walk(&base, &base, &mut out);
        out.sort();
        out
    }

    fn page(&self, slug: &str, page_type: &str, title: &str, body: &str) -> WriteOut {
        self.app()
            .new_page(new_in(slug, page_type, title, body))
            .unwrap()
    }
}

fn new_in(slug: &str, page_type: &str, title: &str, body: &str) -> NewIn {
    NewIn {
        slug: slug.into(),
        page_type: page_type.into(),
        title: title.into(),
        summary: format!("About {title}"),
        tags: vec![],
        body: body.into(),
    }
}

fn code<T>(r: Result<T, AppError>) -> ErrorCode {
    match r {
        Ok(_) => panic!("expected an error"),
        Err(e) => e.code,
    }
}

fn slugs(out: &[impl HasSlug]) -> Vec<String> {
    out.iter().map(|x| x.slug().to_owned()).collect()
}

trait HasSlug {
    fn slug(&self) -> &str;
}
impl HasSlug for mwf_app::SearchHit {
    fn slug(&self) -> &str {
        &self.slug
    }
}
impl HasSlug for mwf_app::PageSummary {
    fn slug(&self) -> &str {
        &self.slug
    }
}
impl HasSlug for mwf_app::RelatedPage {
    fn slug(&self) -> &str {
        &self.slug
    }
}

// --- init / open ---

#[test]
fn init_modes_and_errors() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    assert_eq!(code(App::init(&root, false)), ErrorCode::NotGitRoot);
    assert_eq!(code(App::open(&root)), ErrorCode::NotInitialized);
    fs::create_dir(root.join(".git")).unwrap();
    let out = App::init(&root, false).unwrap();
    assert_eq!(out.mode, "git");
    assert_eq!(out.root, root.display().to_string());
    assert!(out.next_steps.contains(".gitattributes"));
    let err = App::init(&root, true).unwrap_err();
    assert_eq!(err.code, ErrorCode::AlreadyInitialized);
    assert_eq!(
        serde_json::to_value(&err).unwrap()["code"],
        "ALREADY_INITIALIZED"
    );

    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    let out = App::init(&root, true).unwrap();
    assert_eq!(out.mode, "local");
    assert!(out.next_steps.contains(".gitignore"));
    let sub = root.join("src/deep");
    fs::create_dir_all(&sub).unwrap();
    assert_eq!(App::open(&sub).unwrap().root(), root);
}

#[test]
fn init_index_equals_first_rebuild() {
    let env = Env::new();
    let before = env.read("index.md");
    assert_eq!(env.app().index(false).unwrap(), before);
    env.app().index(true).unwrap();
    assert_eq!(env.read("index.md"), before);
}

// --- new ---

#[test]
fn new_writes_page_index_and_log() {
    let env = Env::new();
    let mut input = new_in("use-bm25", "decision", "Use BM25", "We rank with BM25.\n");
    input.tags = vec!["search".into(), "rank".into(), "search".into()];
    let out = env.app().new_page(input).unwrap();
    assert!(out.changed);
    let file = env.page_file("use-bm25");
    assert_eq!(
        file,
        "---\ntitle: Use BM25\ntype: decision\nsummary: About Use BM25\ntags: [search, rank]\nstatus: active\ncreated: 2026-11-20T10:00:00Z\nupdated: 2026-11-20T10:00:00Z\n---\nWe rank with BM25.\n"
    );
    assert_eq!(out.rev, env.app().show("use-bm25").unwrap().rev);
    assert_eq!(out.rev.len(), 12);
    assert!(
        env.read("index.md")
            .contains("## decision\n- [Use BM25](pages/use-bm25.md) — About Use BM25\n")
    );
    assert_eq!(
        env.log(),
        ["2026-11-20T10:00:00Z new use-bm25 \"Use BM25\""]
    );
}

#[test]
fn new_rejections_write_nothing() {
    let env = Env::new();
    env.page("taken", "task", "Taken", "");
    let before = env.snapshot();
    let app = env.app();
    let cases: Vec<(NewIn, ErrorCode)> = vec![
        (new_in("taken", "task", "X", ""), ErrorCode::AlreadyExists),
        (new_in("Bad_Slug", "task", "X", ""), ErrorCode::InvalidSlug),
        (new_in("", "task", "X", ""), ErrorCode::InvalidSlug),
        (new_in("a", "note", "X", ""), ErrorCode::InvalidField),
        (new_in("a", "task", "", ""), ErrorCode::InvalidField),
        (
            new_in("a", "task", "two\nlines", ""),
            ErrorCode::InvalidField,
        ),
        (
            NewIn {
                summary: "x".repeat(121),
                ..new_in("a", "task", "X", "")
            },
            ErrorCode::InvalidField,
        ),
        (
            NewIn {
                tags: vec![" padded".into()],
                ..new_in("a", "task", "X", "")
            },
            ErrorCode::InvalidField,
        ),
        (
            new_in("a", "task", "X", &"b".repeat(BODY_MAX_BYTES + 1)),
            ErrorCode::TooLarge,
        ),
        (
            new_in("a", "task", "X", &format!("token {}\n", secret())),
            ErrorCode::SecretDetected,
        ),
        (
            NewIn {
                summary: format!("key {}", secret()),
                ..new_in("a", "task", "X", "")
            },
            ErrorCode::SecretDetected,
        ),
    ];
    for (input, expected) in cases {
        let slug = input.slug.clone();
        assert_eq!(code(app.new_page(input)), expected, "{slug}");
    }
    assert_eq!(env.snapshot(), before);
}

#[test]
fn body_limit_is_exactly_100_kib() {
    let env = Env::new();
    assert_eq!(BODY_MAX_BYTES, 102_400);
    let body = "b".repeat(BODY_MAX_BYTES);
    env.page("big", "knowledge", "Big", &body);
    // Multi-byte characters count by bytes: 34134 × 3 bytes = 102402 > limit.
    let err = env
        .app()
        .new_page(new_in("cjk", "knowledge", "C", &"中".repeat(34_134)))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::TooLarge);
    assert_eq!(err.details["size"], 102_402);
    assert_eq!(err.details["limit"], 102_400);
}

#[test]
fn secret_error_never_echoes_the_secret() {
    let env = Env::new();
    let key = secret();
    let err = env
        .app()
        .new_page(new_in("k", "knowledge", "K", &format!("a\n{key}\n")))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::SecretDetected);
    let json = serde_json::to_string(&err).unwrap();
    assert!(!json.contains(&key[4..]), "{json}");
    assert!(!err.message.contains(&key[4..]));
    // Line 11 of the page file: 9 frontmatter lines, then `a`, then the key.
    assert_eq!(err.details["findings"][0]["line"], 11);
    assert!(!env.mwf("pages/k.md").exists());
}

#[test]
fn write_out_warns_about_dangling_links() {
    let env = Env::new();
    env.page("there", "knowledge", "There", "");
    let out = env.page(
        "a",
        "knowledge",
        "A",
        "[ok](there.md) [gone](missing.md#x) [gone again](./missing.md) [web](https://x.io/y.md) `[code](nope.md)`\n",
    );
    assert_eq!(out.warnings.len(), 1);
    assert_eq!(out.warnings[0].rule, "dangling_link");
    assert!(out.warnings[0].message.contains("missing.md"));
}

#[test]
fn related_unlinked_top_three_skips_linked_archived_and_weak_pages() {
    let env = Env::new();
    let topic = "deploy pipeline staging rollback canary release";
    for s in ["r1", "r2", "r3", "r4", "linked", "old"] {
        env.page(
            s,
            "knowledge",
            &format!("Deploy {s}"),
            &format!("{topic}\n"),
        );
    }
    env.app().archive("old", true).unwrap();
    // Shares a single term only: below RELATED_MIN_TERMS.
    env.page("weak", "knowledge", "Weak", "canary bird song\n");
    env.page("other", "knowledge", "Cooking", "pasta tomato basil\n");
    let out = env.page(
        "fresh",
        "knowledge",
        "Deploy notes",
        &format!("{topic}\nSee [linked](linked.md).\n"),
    );
    let related = slugs(&out.related_unlinked);
    assert_eq!(related.len(), 3, "{related:?}");
    for s in &related {
        assert!(
            ["r1", "r2", "r3", "r4"].contains(&s.as_str()),
            "{related:?}"
        );
    }
    assert!(!out.related_unlinked[0].title.is_empty());
    assert_eq!(
        out.related_unlinked[0].summary,
        format!("About {}", out.related_unlinked[0].title)
    );
}

// --- show ---

#[test]
fn show_has_rev_and_links_with_titles() {
    let env = Env::new();
    env.page("b", "knowledge", "Bee", "");
    env.page(
        "a",
        "decision",
        "Ay",
        "[b](b.md), [b again](b.md#top), [x](missing.md)\n",
    );
    env.page("c", "task", "Cee", "back to [a](./a.md)\n");
    fs::write(env.mwf("pages/broken.md"), "not a page [a](a.md)").unwrap();
    let view = env.app().show("a").unwrap();
    assert_eq!(view.page_type, "decision");
    assert_eq!(view.status, "active");
    assert_eq!(view.created, "2026-11-20T10:00:00Z");
    assert_eq!(
        view.body,
        "[b](b.md), [b again](b.md#top), [x](missing.md)\n"
    );
    let out: Vec<_> = view
        .links_out
        .iter()
        .map(|l| (l.slug.as_str(), l.exists, l.title.as_deref()))
        .collect();
    assert_eq!(out, [("b", true, Some("Bee")), ("missing", false, None)]);
    assert_eq!(view.links_out[0].summary.as_deref(), Some("About Bee"));
    // The invalid file `broken` is not a backlink.
    let inn: Vec<_> = view.links_in.iter().map(|l| l.slug.as_str()).collect();
    assert_eq!(inn, ["c"]);
    assert_eq!(view.links_in[0].title.as_deref(), Some("Cee"));
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["type"], "decision");
}

#[test]
fn show_errors() {
    let env = Env::new();
    assert_eq!(code(env.app().show("nope")), ErrorCode::NotFound);
    assert_eq!(code(env.app().show("../etc")), ErrorCode::InvalidSlug);
    fs::write(env.mwf("pages/broken.md"), "no frontmatter").unwrap();
    assert_eq!(code(env.app().show("broken")), ErrorCode::InvalidPage);
    fs::write(env.mwf("pages/bytes.md"), [0xff, 0xfe]).unwrap();
    assert_eq!(code(env.app().show("bytes")), ErrorCode::InvalidPage);
}

#[cfg(unix)]
#[test]
fn symlinked_page_is_wrong_file_type() {
    let env = Env::new();
    let outside = env.root.join("outside.md");
    fs::write(&outside, "x").unwrap();
    std::os::unix::fs::symlink(&outside, env.mwf("pages/link.md")).unwrap();
    assert_eq!(code(env.app().show("link")), ErrorCode::WrongFileType);
    assert_eq!(
        code(env.app().list(&ListIn::default())),
        ErrorCode::WrongFileType
    );
}

#[test]
fn replaced_mwf_is_changed() {
    let env = Env::new();
    let app = env.app();
    fs::rename(env.mwf(""), env.root.join("moved")).unwrap();
    fs::create_dir(env.mwf("")).unwrap();
    assert_eq!(code(app.show("a")), ErrorCode::Changed);
    assert_eq!(
        code(app.new_page(new_in("a", "task", "A", ""))),
        ErrorCode::Changed
    );
}

// --- search / list ---

fn corpus() -> Env {
    let env = Env::new();
    let mut a = new_in(
        "deploy",
        "decision",
        "Deploy with canary",
        "canary rollout steps\n",
    );
    a.tags = vec!["ops".into(), "release".into()];
    env.app().new_page(a).unwrap();
    let mut b = new_in(
        "rollback",
        "incident",
        "Rollback failed",
        "canary rollback broke\n",
    );
    b.tags = vec!["ops".into()];
    env.app().new_page(b).unwrap();
    env.page("style", "preference", "Code style", "use tabs\n");
    env.page("legacy", "decision", "Old canary", "canary in 2020\n");
    env.app().archive("legacy", true).unwrap();
    env
}

#[test]
fn search_filters_and_revs() {
    let env = corpus();
    let app = env.app();
    let q = |query: &str| SearchIn {
        query: query.into(),
        ..SearchIn::default()
    };
    let hits = app.search(&q("canary")).unwrap();
    assert_eq!(slugs(&hits), ["deploy", "rollback"]);
    assert!(hits[0].score >= hits[1].score);
    assert_eq!(hits[0].rev, app.show("deploy").unwrap().rev);
    assert_eq!(hits[0].page_type, "decision");

    let all = app
        .search(&SearchIn {
            status: StatusFilter::All,
            ..q("canary")
        })
        .unwrap();
    assert_eq!(all.len(), 3);
    let archived = app
        .search(&SearchIn {
            status: StatusFilter::Archived,
            ..q("canary")
        })
        .unwrap();
    assert_eq!(slugs(&archived), ["legacy"]);
    let typed = app
        .search(&SearchIn {
            types: vec!["incident".into(), "preference".into()],
            ..q("canary")
        })
        .unwrap();
    assert_eq!(slugs(&typed), ["rollback"]);
    let tagged = app
        .search(&SearchIn {
            tags: vec!["ops".into(), "release".into()],
            ..q("canary")
        })
        .unwrap();
    assert_eq!(slugs(&tagged), ["deploy"]);
    let limited = app
        .search(&SearchIn {
            limit: 1,
            ..q("canary")
        })
        .unwrap();
    assert_eq!(limited.len(), 1);
    assert!(app.search(&q("nothing-matches-this")).unwrap().is_empty());
    assert_eq!(
        code(app.search(&SearchIn {
            types: vec!["note".into()],
            ..q("canary")
        })),
        ErrorCode::InvalidField
    );
}

#[test]
fn list_filters_sorted_by_slug() {
    let env = corpus();
    fs::write(env.mwf("pages/broken.md"), "junk").unwrap();
    let app = env.app();
    let list = |types: &[&str], tags: &[&str], status| {
        slugs(
            &app.list(&ListIn {
                types: types.iter().map(|s| (*s).to_owned()).collect(),
                tags: tags.iter().map(|s| (*s).to_owned()).collect(),
                status,
            })
            .unwrap(),
        )
    };
    assert_eq!(
        list(&[], &[], StatusFilter::Active),
        ["deploy", "rollback", "style"]
    );
    assert_eq!(
        list(&[], &[], StatusFilter::All),
        ["deploy", "legacy", "rollback", "style"]
    );
    assert_eq!(
        list(&["decision"], &[], StatusFilter::All),
        ["deploy", "legacy"]
    );
    assert_eq!(
        list(&[], &["ops"], StatusFilter::Active),
        ["deploy", "rollback"]
    );
    let one = &app.list(&ListIn::default()).unwrap()[0];
    assert_eq!(one.tags, ["ops", "release"]);
    assert_eq!(one.rev, app.show("deploy").unwrap().rev);
}

// --- index / log ---

#[test]
fn index_prints_current_pages_and_rebuild_repairs_without_logging() {
    let env = corpus();
    let good = env.read("index.md");
    fs::write(env.mwf("index.md"), "stale").unwrap();
    let log_before = env.log();
    assert_eq!(env.app().index(false).unwrap(), good);
    assert_eq!(env.read("index.md"), "stale");
    assert_eq!(env.app().index(true).unwrap(), good);
    assert_eq!(env.read("index.md"), good);
    fs::remove_file(env.mwf("index.md")).unwrap();
    env.app().index(true).unwrap();
    assert_eq!(env.read("index.md"), good);
    assert_eq!(env.log(), log_before);
    assert!(!good.contains("legacy"));
}

#[test]
fn log_returns_the_last_n_lines() {
    let env = corpus();
    let all = env.app().log(100).unwrap();
    assert_eq!(all.len(), 5);
    assert_eq!(env.app().log(2).unwrap(), all[3..]);
    assert_eq!(all[4], "2026-11-20T10:00:00Z archive legacy \"Old canary\"");
    assert!(env.app().log(0).unwrap().is_empty());
}

// --- write / patch: conflicts ---

#[test]
fn write_requires_the_current_rev() {
    let env = Env::new();
    let created = env.page("p", "knowledge", "P", "one\n");
    let app = env.app_at(T0 + 60);
    // Someone else patches after we read.
    app.patch(PatchIn {
        slug: "p".into(),
        old: "one".into(),
        new: "two".into(),
    })
    .unwrap();
    let before = env.snapshot();
    let err = app
        .write(WriteIn {
            slug: "p".into(),
            rev: created.rev.clone(),
            body: "three\n".into(),
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::RevMismatch);
    let current = app.show("p").unwrap().rev;
    assert_eq!(err.details["current_rev"], current.as_str());
    assert_eq!(env.snapshot(), before);

    let out = app
        .write(WriteIn {
            slug: "p".into(),
            rev: current.clone(),
            body: "three\n".into(),
        })
        .unwrap();
    assert_ne!(out.rev, current);
    let view = app.show("p").unwrap();
    assert_eq!(
        (view.body.as_str(), view.rev.as_str()),
        ("three\n", out.rev.as_str())
    );
    assert_eq!(view.created, "2026-11-20T10:00:00Z");
    assert_eq!(view.updated, "2026-11-20T10:01:00Z");
    assert_eq!(
        env.log()[1..],
        [
            "2026-11-20T10:01:00Z patch p \"P\"",
            "2026-11-20T10:01:00Z write p \"P\""
        ]
    );
    assert_eq!(
        code(app.write(WriteIn {
            slug: "nope".into(),
            rev: current,
            body: String::new(),
        })),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(app.write(WriteIn {
            slug: "p".into(),
            rev: view.rev.clone(),
            body: "x".repeat(BODY_MAX_BYTES + 1),
        })),
        ErrorCode::TooLarge
    );
}

#[test]
fn secret_scan_checks_only_added_content() {
    let env = Env::new();
    let key = secret();
    // A stored secret (written by hand, as lint would find it).
    env.page("p", "knowledge", "P", "intro\n");
    let file = env
        .page_file("p")
        .replace("intro\n", &format!("intro\n{key}\n"));
    fs::write(env.mwf("pages/p.md"), file).unwrap();
    let app = env.app();
    // Editing other text keeps the existing secret: allowed.
    app.patch(PatchIn {
        slug: "p".into(),
        old: "intro".into(),
        new: "start".into(),
    })
    .unwrap();
    // Copying it to a second place is new content.
    let rev = app.show("p").unwrap().rev;
    assert_eq!(
        code(app.write(WriteIn {
            slug: "p".into(),
            rev,
            body: format!("start\n{key}\n{key}\n"),
        })),
        ErrorCode::SecretDetected
    );
}

#[test]
fn patch_errors_and_success() {
    let env = Env::new();
    env.page("p", "knowledge", "P", "alpha beta beta\n");
    let app = env.app();
    let patch = |old: &str, new: &str| {
        app.patch(PatchIn {
            slug: "p".into(),
            old: old.into(),
            new: new.into(),
        })
    };
    let before = env.snapshot();
    assert_eq!(code(patch("gamma", "x")), ErrorCode::PatchNoMatch);
    let err = patch("beta", "x").unwrap_err();
    assert_eq!(err.code, ErrorCode::PatchAmbiguous);
    assert_eq!(err.details["matches"], 2);
    assert_eq!(code(patch("", "x")), ErrorCode::InvalidField);
    assert_eq!(
        code(patch(&"a".repeat(BODY_MAX_BYTES + 1), "x")),
        ErrorCode::TooLarge
    );
    assert_eq!(
        code(patch("alpha", &"a".repeat(BODY_MAX_BYTES + 1))),
        ErrorCode::TooLarge
    );
    // The result would exceed the body limit.
    assert_eq!(
        code(patch("alpha", &"a".repeat(BODY_MAX_BYTES))),
        ErrorCode::TooLarge
    );
    assert_eq!(code(patch("alpha", &secret())), ErrorCode::SecretDetected);
    // The frontmatter is not part of the body.
    assert_eq!(code(patch("title: P", "title: Q")), ErrorCode::PatchNoMatch);
    assert_eq!(env.snapshot(), before);
    let out = patch("alpha", "ALPHA").unwrap();
    assert!(out.changed);
    assert_eq!(app.show("p").unwrap().body, "ALPHA beta beta\n");
}

// --- set / archive ---

#[test]
fn set_changes_fields_and_regroups_index() {
    let env = Env::new();
    let mut input = new_in("p", "task", "P", "");
    input.tags = vec!["a".into(), "b".into()];
    env.app().new_page(input).unwrap();
    let app = env.app_at(T0 + DAY);
    app.set(SetIn {
        slug: "p".into(),
        title: Some("New title".into()),
        page_type: Some("decision".into()),
        summary: Some("New summary".into()),
        add_tags: vec!["c".into(), "a".into()],
        remove_tags: vec!["b".into()],
    })
    .unwrap();
    let view = app.show("p").unwrap();
    assert_eq!(view.title, "New title");
    assert_eq!(view.page_type, "decision");
    assert_eq!(view.tags, ["a", "c"]);
    assert_eq!(view.updated, "2026-11-21T10:00:00Z");
    let index = env.read("index.md");
    assert!(index.contains("## decision\n- [New title](pages/p.md) — New summary\n"));
    assert!(!index.contains("## task"));
    assert_eq!(
        env.log().last().unwrap(),
        "2026-11-21T10:00:00Z set p \"New title\""
    );
}

#[test]
fn set_rejections_and_no_op() {
    let env = Env::new();
    env.page("p", "task", "P", "");
    let app = env.app_at(T0 + 60);
    let before = env.snapshot();
    let set = |i: SetIn| {
        app.set(SetIn {
            slug: "p".into(),
            ..i
        })
    };
    assert_eq!(code(set(SetIn::default())), ErrorCode::InvalidField);
    assert_eq!(
        code(set(SetIn {
            page_type: Some("note".into()),
            ..SetIn::default()
        })),
        ErrorCode::InvalidField
    );
    assert_eq!(
        code(set(SetIn {
            summary: Some("s".repeat(121)),
            ..SetIn::default()
        })),
        ErrorCode::InvalidField
    );
    assert_eq!(
        code(set(SetIn {
            add_tags: vec!["x".into()],
            remove_tags: vec!["x".into()],
            ..SetIn::default()
        })),
        ErrorCode::InvalidField
    );
    assert_eq!(
        code(set(SetIn {
            title: Some(format!("t {}", secret())),
            ..SetIn::default()
        })),
        ErrorCode::SecretDetected
    );
    assert_eq!(
        code(app.set(SetIn {
            slug: "nope".into(),
            title: Some("x".into()),
            ..SetIn::default()
        })),
        ErrorCode::NotFound
    );
    // Same title, removing an absent tag: nothing to change, so nothing is written or logged.
    let rev = app.show("p").unwrap().rev;
    let out = set(SetIn {
        title: Some("P".into()),
        remove_tags: vec!["absent".into()],
        ..SetIn::default()
    })
    .unwrap();
    assert!(!out.changed);
    assert_eq!(out.rev, rev);
    assert_eq!(env.snapshot(), before);
}

#[test]
fn archive_and_unarchive() {
    let env = Env::new();
    env.page("p", "knowledge", "P", "canary\n");
    let app = env.app();
    let out = app.archive("p", true).unwrap();
    assert!(out.changed);
    assert_eq!(app.show("p").unwrap().status, "archived");
    assert!(!env.read("index.md").contains("pages/p.md"));
    let q = SearchIn {
        query: "canary".into(),
        ..SearchIn::default()
    };
    assert!(app.search(&q).unwrap().is_empty());
    // Archiving again changes nothing.
    assert!(!app.archive("p", true).unwrap().changed);
    app.archive("p", false).unwrap();
    assert!(env.read("index.md").contains("pages/p.md"));
    assert_eq!(app.search(&q).unwrap().len(), 1);
    let ops: Vec<String> = env
        .log()
        .iter()
        .map(|l| l.split(' ').nth(1).unwrap().to_owned())
        .collect();
    assert_eq!(ops, ["new", "archive", "unarchive"]);
    assert_eq!(code(app.archive("nope", true)), ErrorCode::NotFound);
}

// --- rename ---

#[test]
fn rename_rewrites_every_internal_link() {
    let env = Env::new();
    env.page("old", "knowledge", "Old", "self [me](old.md#top)\n");
    env.page(
        "ref",
        "task",
        "Ref",
        "[see](./old.md#part) and [again](../pages/old.md \"t\") `[code](old.md)`\n",
    );
    env.page("other", "task", "Other", "[unrelated](ref.md)\n");
    fs::write(env.mwf("pages/broken.md"), "junk [x](old.md)").unwrap();
    let app = env.app_at(T0 + 60);
    let out = app.rename("old", "new").unwrap();
    assert_eq!(out.slug, "new");
    assert_eq!(out.also_updated, ["ref"]);
    assert_eq!(out.warnings.len(), 1);
    assert_eq!(out.warnings[0].rule, "invalid_page_skipped");
    assert!(!env.mwf("pages/old.md").exists());
    let moved = app.show("new").unwrap();
    assert_eq!(moved.body, "self [me](new.md#top)\n");
    assert_eq!(moved.rev, out.rev);
    assert_eq!(moved.created, "2026-11-20T10:00:00Z");
    let r = app.show("ref").unwrap();
    assert_eq!(
        r.body,
        "[see](./new.md#part) and [again](../pages/new.md \"t\") `[code](old.md)`\n"
    );
    assert_eq!(r.updated, "2026-11-20T10:01:00Z");
    assert_eq!(app.show("other").unwrap().updated, "2026-11-20T10:00:00Z");
    assert!(env.read("index.md").contains("pages/new.md"));
    assert!(!env.read("index.md").contains("pages/old.md"));
    assert_eq!(
        env.log().last().unwrap(),
        "2026-11-20T10:01:00Z rename old->new \"Old\""
    );
    assert_eq!(env.log().len(), 4);
}

#[test]
fn rename_errors() {
    let env = Env::new();
    env.page("a", "task", "A", "");
    env.page("b", "task", "B", "");
    let app = env.app();
    let before = env.snapshot();
    assert_eq!(code(app.rename("a", "b")), ErrorCode::AlreadyExists);
    assert_eq!(code(app.rename("nope", "c")), ErrorCode::NotFound);
    assert_eq!(code(app.rename("a", "a")), ErrorCode::InvalidField);
    assert_eq!(code(app.rename("a", "C")), ErrorCode::InvalidSlug);
    assert_eq!(env.snapshot(), before);
}

// --- delete ---

#[test]
fn delete_refuses_with_backlinks_and_unlinks_on_request() {
    let env = Env::new();
    env.page("gone", "knowledge", "Gone", "");
    env.page("x", "task", "X", "see [the page](gone.md#a), [y](y.md)\n");
    env.page("y", "task", "Y", "[x](x.md)\n");
    let app = env.app_at(T0 + 60);
    let before = env.snapshot();
    let err = app.delete("gone", false).unwrap_err();
    assert_eq!(err.code, ErrorCode::HasBacklinks);
    assert_eq!(err.details["backlinks"], serde_json::json!(["x"]));
    assert_eq!(env.snapshot(), before);

    let out = app.delete("gone", true).unwrap();
    assert_eq!(out.unlinked, ["x"]);
    assert_eq!(out.trashed, ".mwf/trash/gone.2026-11-20T10:01:00Z.md");
    assert!(env.root.join(&out.trashed).is_file());
    assert!(!env.mwf("pages/gone.md").exists());
    assert_eq!(app.show("x").unwrap().body, "see the page, [y](y.md)\n");
    assert_eq!(app.show("x").unwrap().updated, "2026-11-20T10:01:00Z");
    assert_eq!(
        env.log().last().unwrap(),
        "2026-11-20T10:01:00Z delete gone \"Gone\""
    );
    assert!(!env.read("index.md").contains("gone"));
    assert_eq!(code(app.delete("gone", true)), ErrorCode::NotFound);
}

#[test]
fn delete_without_backlinks_and_of_an_invalid_page() {
    let env = Env::new();
    env.page("lone", "task", "Lone", "[self](lone.md)\n");
    let app = env.app();
    app.delete("lone", false).unwrap();
    fs::write(env.mwf("pages/broken.md"), "junk").unwrap();
    let out = app.delete("broken", false).unwrap();
    assert!(out.unlinked.is_empty());
    assert_eq!(
        env.log().last().unwrap(),
        "2026-11-20T10:00:00Z delete broken \"\""
    );
    // Same slug, same second: the trash keeps both.
    env.page("lone", "task", "Lone", "");
    let again = app.delete("lone", false).unwrap();
    assert_eq!(again.trashed, ".mwf/trash/lone.2026-11-20T10:00:00Z.1.md");
}

// --- updating an invalid page ---

#[test]
fn writes_to_an_invalid_page_are_invalid_page() {
    let env = Env::new();
    fs::write(env.mwf("pages/broken.md"), "junk").unwrap();
    let app = env.app();
    assert_eq!(
        code(app.patch(PatchIn {
            slug: "broken".into(),
            old: "junk".into(),
            new: "x".into(),
        })),
        ErrorCode::InvalidPage
    );
    assert_eq!(code(app.archive("broken", true)), ErrorCode::InvalidPage);
    assert_eq!(code(app.rename("broken", "fixed")), ErrorCode::InvalidPage);
}

// --- lock ---

#[test]
fn writes_wait_for_the_lock_then_time_out() {
    let env = Env::new();
    env.page("p", "task", "P", "");
    let before = env.snapshot();
    let held = File::options()
        .read(true)
        .write(true)
        .open(env.mwf(".lock"))
        .unwrap();
    held.lock().unwrap();
    let app = env.app();
    let start = Instant::now();
    let err = app.new_page(new_in("q", "task", "Q", "")).unwrap_err();
    assert_eq!(err.code, ErrorCode::LockTimeout);
    assert!(start.elapsed() >= Duration::from_secs(2));
    assert_eq!(err.details["waited_ms"], 2000);
    // Reads never wait for the lock (ADR 0033); `index --rebuild` is a write.
    let start = Instant::now();
    app.show("p").unwrap();
    app.list(&ListIn::default()).unwrap();
    app.index(false).unwrap();
    app.lint().unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(code(app.delete("p", false)), ErrorCode::LockTimeout);
    drop(held);
    assert_eq!(env.snapshot(), before);
    app.new_page(new_in("q", "task", "Q", "")).unwrap();
}

#[test]
fn concurrent_writers_lose_no_log_line_or_index_entry() {
    let env = Env::new();
    let root = env.root.clone();
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let root = root.clone();
            std::thread::spawn(move || {
                let app = App::open_with_clock(&root, Box::new(FixedClock(T0))).unwrap();
                app.new_page(new_in(&format!("p{i}"), "task", "T", ""))
                    .unwrap();
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(env.log().len(), 8);
    let index = env.read("index.md");
    for i in 0..8 {
        assert!(index.contains(&format!("pages/p{i}.md")), "{index}");
    }
    assert_eq!(env.app().index(false).unwrap(), index);
}

// --- lint ---

fn lint_rules(env: &Env, secs: u64) -> Vec<(Option<String>, &'static str, Severity)> {
    env.app_at(secs)
        .lint()
        .unwrap()
        .issues
        .into_iter()
        .map(|i| (i.page, i.rule, i.severity))
        .collect()
}

fn hub(env: &Env, targets: &[&str]) {
    let body: String = targets.iter().map(|t| format!("[{t}]({t}.md)\n")).collect();
    env.page("hub", "knowledge", "Hub", &body);
}

#[test]
fn clean_project_lints_clean() {
    let env = Env::new();
    let report = env.app().lint().unwrap();
    assert_eq!((report.errors, report.warnings), (0, 0));
    env.page(
        "a",
        "decision",
        "Alpha decision",
        "about rockets [b](b.md)\n",
    );
    env.page(
        "b",
        "knowledge",
        "Beta knowledge",
        "about gardens [a](a.md)\n",
    );
    assert_eq!(lint_rules(&env, T0), []);
}

#[test]
fn lint_reports_every_rule() {
    let env = Env::new();
    env.page(
        "fine",
        "decision",
        "Fine",
        "[t](task.md) [gone](missing.md)\n",
    );
    env.page("task", "task", "Old task", "[f](fine.md)\n");
    // Orphan: nothing links to it; a self-link does not count.
    env.page("alone", "knowledge", "Alone", "[me](alone.md)\n");
    // Archived pages are not orphans.
    env.page("retired", "knowledge", "Retired", "");
    env.app().archive("retired", true).unwrap();
    let key = secret();
    fs::write(env.mwf("pages/Bad_Name.md"), env.page_file("fine")).unwrap();
    fs::write(env.mwf("pages/broken.md"), "junk [f](fine.md)").unwrap();
    fs::write(env.mwf("pages/bytes.md"), [0xff]).unwrap();
    env.page(
        "leaky",
        "task",
        "Leaky",
        "notes about gardens [f](fine.md)\n",
    );
    let leaky = env
        .page_file("leaky")
        .replace("gardens", &format!("gardens {key}"));
    fs::write(env.mwf("pages/leaky.md"), leaky).unwrap();
    fs::write(env.mwf("index.md"), "edited by hand").unwrap();
    fs::write(env.mwf("config.toml"), "[hooks]\nrecal_top_k = 1\n").unwrap();

    let s = |x: &str| Some(x.to_owned());
    // Invalid page files take no part in the link graph: `Bad_Name` (a copy of `fine`) has no
    // dangling_link and is no backlink, and `broken`'s link does not keep `fine` from being
    // linked only through `task`.
    // 31 days later: `task` and `leaky` are stale.
    let rules = lint_rules(&env, T0 + 31 * DAY);
    assert_eq!(
        rules,
        [
            (None, "index_drift", Severity::Warning),
            (None, "invalid_config", Severity::Error),
            (s("Bad_Name"), "invalid_slug", Severity::Error),
            (s("alone"), "orphan", Severity::Warning),
            (s("broken"), "invalid_frontmatter", Severity::Error),
            (s("bytes"), "invalid_frontmatter", Severity::Error),
            (s("fine"), "dangling_link", Severity::Warning),
            (s("leaky"), "orphan", Severity::Warning),
            (s("leaky"), "secret", Severity::Error),
            (s("leaky"), "stale_task", Severity::Warning),
            (s("task"), "stale_task", Severity::Warning),
        ]
    );
    let report = env.app_at(T0 + 31 * DAY).lint().unwrap();
    assert_eq!((report.errors, report.warnings), (5, 6));
    let json = serde_json::to_string(&report).unwrap();
    assert!(!json.contains(&key[4..]), "{json}");
    // Lint never writes.
    assert_eq!(env.read("index.md"), "edited by hand");
}

#[test]
fn missing_index_is_drift() {
    let env = Env::new();
    fs::remove_file(env.mwf("index.md")).unwrap();
    assert_eq!(
        lint_rules(&env, T0),
        [(None, "index_drift", Severity::Warning)]
    );
}

#[test]
fn possible_duplicate_flags_near_copies_only() {
    let env = Env::new();
    let text = "The deploy pipeline builds the image, runs the canary on staging, waits for health checks, then promotes to production and keeps the previous image for rollback.";
    env.page(
        "deploy",
        "knowledge",
        "Deploy pipeline",
        &format!("{text}\n"),
    );
    env.page(
        "deploy-copy",
        "knowledge",
        "Deploy pipeline steps",
        &format!("{text} Ask the on-call before promoting.\n"),
    );
    // Same topic, different content: related, not a duplicate.
    env.page(
        "rollback",
        "incident",
        "Rollback failed",
        "The rollback to the previous image failed because the registry pruned old tags; we now pin tags for a week.\n",
    );
    env.page(
        "tabs",
        "preference",
        "Use tabs",
        "Indent with tabs in every language.\n",
    );
    // An archived copy is not reported.
    env.page(
        "deploy-old",
        "knowledge",
        "Deploy pipeline",
        &format!("{text}\n"),
    );
    env.app().archive("deploy-old", true).unwrap();
    hub(
        &env,
        &["deploy", "deploy-copy", "rollback", "tabs", "deploy-old"],
    );
    let dups: Vec<_> = env
        .app()
        .lint()
        .unwrap()
        .issues
        .into_iter()
        .filter(|i| i.rule == "possible_duplicate")
        .map(|i| (i.page.unwrap(), i.message))
        .collect();
    assert_eq!(dups.len(), 2, "{dups:?}");
    assert_eq!(dups[0].0, "deploy");
    assert!(dups[0].1.contains("deploy-copy"));
    assert_eq!(dups[1].0, "deploy-copy");
    assert!(dups[1].1.contains("deploy "), "{}", dups[1].1);
}

#[test]
fn lint_now_comes_from_the_clock() {
    let env = Env::new();
    env.page("t", "task", "Task", "");
    hub(&env, &["t"]);
    let at = |days| {
        lint_rules(&env, T0 + days * DAY)
            .into_iter()
            .filter(|r| r.1 == "stale_task")
            .count()
    };
    assert_eq!(at(29), 0);
    assert_eq!(at(30), 1);
}

#[test]
fn error_codes_serialize_as_documented() {
    for c in ErrorCode::ALL {
        assert_eq!(
            serde_json::to_value(c).unwrap(),
            serde_json::Value::from(c.as_str())
        );
    }
    let env = Env::new();
    let err = env.app().show("nope").unwrap_err();
    assert_eq!(
        serde_json::to_value(&err).unwrap(),
        serde_json::json!({
            "code": "NOT_FOUND",
            "message": "page nope does not exist",
            "details": { "slug": "nope" },
        })
    );
}
