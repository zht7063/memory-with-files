//! Integration tests of `mwf-store` against real directories.

// Tests may unwrap and panic (ADR 0043); clippy.toml's test exemption does not reach the
// helper functions of an integration test crate.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use mwf_domain::{Slug, Timestamp, render_index};
use mwf_store::{
    Config, DEFAULT_CONFIG_TOML, GitMode, LOCK_WAIT, MWF_GITIGNORE, Project, StoreError,
};
use tempfile::TempDir;

/// A temp directory with a `.git` directory, canonicalized (macOS `/tmp` is a symlink).
fn git_repo() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    (dir, root)
}

fn init(mode: GitMode) -> (TempDir, Project) {
    let (dir, root) = git_repo();
    let project = Project::init(&root, mode).unwrap();
    (dir, project)
}

fn slug(s: &str) -> Slug {
    Slug::parse(s).unwrap()
}

fn ts(s: &str) -> Timestamp {
    Timestamp::parse(s).unwrap()
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).unwrap()
}

fn names(dir: impl AsRef<Path>) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// --- find (ADR 0019) ---

#[test]
fn find_walks_up_to_the_nearest_mwf_directory() {
    let (_dir, project) = init(GitMode::Track);
    let deep = project.root().join("src/a/b");
    fs::create_dir_all(&deep).unwrap();
    for cwd in [
        project.root().to_path_buf(),
        project.root().join("src"),
        deep,
    ] {
        assert_eq!(
            Project::find(&cwd).unwrap(),
            project,
            "from {}",
            cwd.display()
        );
    }
    // From inside .mwf/ itself.
    assert_eq!(
        Project::find(&project.mwf_dir().join("pages")).unwrap(),
        project
    );
}

#[test]
fn find_prefers_the_innermost_project() {
    let (_dir, outer) = init(GitMode::Track);
    let inner_root = outer.root().join("vendor/lib");
    fs::create_dir_all(inner_root.join(".mwf")).unwrap();
    let from = inner_root.join("src");
    fs::create_dir_all(&from).unwrap();
    assert_eq!(Project::find(&from).unwrap().root(), inner_root);
}

#[test]
fn find_ignores_a_mwf_file() {
    let (_dir, project) = init(GitMode::Track);
    let sub = project.root().join("sub");
    fs::create_dir(&sub).unwrap();
    fs::write(sub.join(".mwf"), "not a directory").unwrap();
    assert_eq!(Project::find(&sub).unwrap(), project);
}

#[test]
fn find_resolves_relative_and_dotted_paths() {
    let (_dir, project) = init(GitMode::Track);
    fs::create_dir_all(project.root().join("a/b")).unwrap();
    let dotted = project.root().join("a/b/../b/.");
    assert_eq!(Project::find(&dotted).unwrap(), project);
}

#[test]
fn find_without_mwf_is_not_initialized() {
    let (_dir, root) = git_repo();
    let sub = root.join("x");
    fs::create_dir(&sub).unwrap();
    match Project::find(&sub).unwrap_err() {
        StoreError::NotInitialized { start } => assert_eq!(start, sub),
        e => panic!("{e:?}"),
    }
}

#[test]
fn find_from_a_missing_directory_is_an_io_error() {
    let (_dir, root) = git_repo();
    assert!(matches!(
        Project::find(&root.join("missing")).unwrap_err(),
        StoreError::Io { .. }
    ));
}

// --- init (ADRs 0019, 0029, 0048) ---

#[test]
fn init_track_writes_the_layout_and_gitattributes() {
    let (_dir, root) = git_repo();
    let project = Project::init(&root, GitMode::Track).unwrap();
    assert_eq!(project.root(), root);
    let mwf = root.join(".mwf");
    assert_eq!(
        names(&mwf),
        [".gitignore", "config.toml", "index.md", "log.md", "pages"]
    );
    assert_eq!(read(mwf.join(".gitignore")), MWF_GITIGNORE);
    assert_eq!(read(mwf.join("config.toml")), DEFAULT_CONFIG_TOML);
    assert_eq!(read(mwf.join("index.md")), render_index(&[]));
    assert_eq!(read(mwf.join("log.md")), "");
    assert!(names(mwf.join("pages")).is_empty());
    assert_eq!(
        read(root.join(".gitattributes")),
        ".mwf/log.md merge=union\n"
    );
    assert!(!root.join(".gitignore").exists());
    assert_eq!(project.config().unwrap(), Config::default());
}

#[test]
fn init_local_ignores_mwf_in_the_root_gitignore() {
    let (_dir, root) = git_repo();
    Project::init(&root, GitMode::Local).unwrap();
    assert_eq!(read(root.join(".gitignore")), "/.mwf/\n");
    assert!(!root.join(".gitattributes").exists());
    // Machine-local files stay ignored even if the user later commits .mwf/.
    assert_eq!(read(root.join(".mwf/.gitignore")), MWF_GITIGNORE);
}

#[test]
fn init_appends_to_existing_root_files_and_keeps_their_content() {
    let (_dir, root) = git_repo();
    fs::write(root.join(".gitattributes"), "*.png binary").unwrap();
    Project::init(&root, GitMode::Track).unwrap();
    assert_eq!(
        read(root.join(".gitattributes")),
        "*.png binary\n.mwf/log.md merge=union\n"
    );

    let (_dir, root) = git_repo();
    fs::write(root.join(".gitignore"), "/target\n").unwrap();
    Project::init(&root, GitMode::Local).unwrap();
    assert_eq!(read(root.join(".gitignore")), "/target\n/.mwf/\n");
}

#[test]
fn init_does_not_repeat_a_line_already_present() {
    let (_dir, root) = git_repo();
    fs::write(root.join(".gitattributes"), "/.mwf/log.md   merge=union\n").unwrap();
    Project::init(&root, GitMode::Track).unwrap();
    assert_eq!(
        read(root.join(".gitattributes")),
        "/.mwf/log.md   merge=union\n"
    );

    let (_dir, root) = git_repo();
    fs::write(root.join(".gitignore"), "node_modules\n.mwf\n").unwrap();
    Project::init(&root, GitMode::Local).unwrap();
    assert_eq!(read(root.join(".gitignore")), "node_modules\n.mwf\n");
}

#[test]
fn init_accepts_a_worktree_or_submodule_git_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join(".git"), "gitdir: /elsewhere/.git/worktrees/wt\n").unwrap();
    let project = Project::init(&root, GitMode::Track).unwrap();
    assert!(project.mwf_dir().join("config.toml").is_file());
}

#[test]
fn init_rejects_a_git_file_that_is_not_a_gitdir_pointer() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join(".git"), "hello\n").unwrap();
    assert!(matches!(
        Project::init(&root, GitMode::Track).unwrap_err(),
        StoreError::NotGitRoot { git_root: None, .. }
    ));
    assert!(!root.join(".mwf").exists());
}

#[test]
fn init_outside_git_is_not_git_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    for mode in [GitMode::Track, GitMode::Local] {
        match Project::init(&root, mode).unwrap_err() {
            StoreError::NotGitRoot { path, git_root } => {
                assert_eq!(path, root);
                // The temp dir is not inside a repository on CI or the orb.
                assert_eq!(git_root, None);
            }
            e => panic!("{e:?}"),
        }
    }
    assert_eq!(names(&root), Vec::<String>::new());
}

#[test]
fn init_in_a_subdirectory_names_the_repository_root() {
    let (_dir, root) = git_repo();
    let sub = root.join("crates/app");
    fs::create_dir_all(&sub).unwrap();
    let err = Project::init(&sub, GitMode::Track).unwrap_err();
    match &err {
        StoreError::NotGitRoot { path, git_root } => {
            assert_eq!(path, &sub);
            assert_eq!(git_root.as_deref(), Some(root.as_path()));
        }
        e => panic!("{e:?}"),
    }
    assert!(
        err.to_string().contains(&root.display().to_string()),
        "{err}"
    );
    assert!(!sub.join(".mwf").exists());
}

#[test]
fn init_on_an_existing_project_changes_nothing() {
    let (_dir, project) = init(GitMode::Track);
    let mwf = project.mwf_dir();
    fs::write(mwf.join("config.toml"), "[hooks]\nrecall_top_k = 9\n").unwrap();
    fs::remove_file(mwf.join("log.md")).unwrap();
    for mode in [GitMode::Track, GitMode::Local] {
        match Project::init(project.root(), mode).unwrap_err() {
            StoreError::AlreadyInitialized { path } => assert_eq!(path, mwf),
            e => panic!("{e:?}"),
        }
    }
    assert_eq!(read(mwf.join("config.toml")), "[hooks]\nrecall_top_k = 9\n");
    assert!(!mwf.join("log.md").exists());
    assert!(!project.root().join(".gitignore").exists());
    assert_eq!(
        read(project.root().join(".gitattributes")),
        ".mwf/log.md merge=union\n"
    );
}

#[test]
fn init_refuses_when_mwf_is_a_file() {
    let (_dir, root) = git_repo();
    fs::write(root.join(".mwf"), "x").unwrap();
    assert!(matches!(
        Project::init(&root, GitMode::Track).unwrap_err(),
        StoreError::AlreadyInitialized { .. }
    ));
    assert_eq!(read(root.join(".mwf")), "x");
}

/// Checks the ignore rules with the real `git` when it is installed; mwf itself never runs git.
#[test]
fn git_ignores_machine_local_files_and_unions_log_md() {
    let git =
        |root: &Path, args: &[&str]| Command::new("git").arg("-C").arg(root).args(args).output();
    let probe = tempfile::tempdir().unwrap();
    if git(probe.path(), &["--version"]).is_err() {
        eprintln!("git not installed; skipping");
        return;
    }
    let ignored = |root: &Path, path: &str| {
        git(root, &["check-ignore", "-q", "--no-index", path])
            .unwrap()
            .status
            .success()
    };

    for mode in [GitMode::Track, GitMode::Local] {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        assert!(git(&root, &["init", "-q"]).unwrap().status.success());
        let project = Project::init(&root, mode).unwrap();
        let guard = project.lock(LOCK_WAIT).unwrap();
        guard.write_page(&slug("a"), b"page").unwrap();
        guard
            .move_to_trash(&slug("a"), &ts("2026-11-20T10:00:00Z"))
            .unwrap();
        drop(guard);
        fs::create_dir_all(root.join(".mwf/.state")).unwrap();
        fs::write(root.join(".mwf/.state/s1.json"), "{}").unwrap();
        fs::write(root.join(".mwf/pages/.b.md.1.0.tmp"), "").unwrap();

        for local in [
            ".mwf/.lock",
            ".mwf/.state/s1.json",
            ".mwf/trash/a.2026-11-20T10:00:00Z.md",
            ".mwf/pages/.b.md.1.0.tmp",
        ] {
            assert!(ignored(&root, local), "{mode:?}: {local} not ignored");
        }
        let shared = [
            ".mwf/config.toml",
            ".mwf/index.md",
            ".mwf/log.md",
            ".mwf/pages/b.md",
            ".mwf/.gitignore",
        ];
        for path in shared {
            assert_eq!(
                ignored(&root, path),
                mode == GitMode::Local,
                "{mode:?}: {path}"
            );
        }
        if mode == GitMode::Track {
            let out = git(&root, &["check-attr", "merge", "--", ".mwf/log.md"]).unwrap();
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                ".mwf/log.md: merge: union\n"
            );
        }
    }
}

// --- config (ADR 0039) ---

#[test]
fn config_missing_file_means_defaults() {
    let (_dir, project) = init(GitMode::Track);
    fs::remove_file(project.mwf_dir().join("config.toml")).unwrap();
    assert_eq!(project.config().unwrap(), Config::default());
}

#[test]
fn config_reads_overrides_and_reports_bad_files() {
    let (_dir, project) = init(GitMode::Track);
    let path = project.mwf_dir().join("config.toml");
    fs::write(&path, "[hooks]\nsession_start_max_chars = 4000\n").unwrap();
    assert_eq!(
        project.config().unwrap().hooks.session_start_max_chars,
        4000
    );
    assert_eq!(project.config().unwrap().hooks.recall_top_k, 3);

    fs::write(&path, "[hooks]\nrecall_topk = 1\n").unwrap();
    match project.config().unwrap_err() {
        StoreError::Config { path: p, message } => {
            assert_eq!(p, path);
            assert!(message.contains("recall_topk"), "{message}");
        }
        e => panic!("{e:?}"),
    }

    fs::write(&path, b"\xff\xfe").unwrap();
    assert!(matches!(
        project.config().unwrap_err(),
        StoreError::Config { .. }
    ));
}

// --- lock (ADRs 0013, 0033) ---

#[test]
fn lock_is_exclusive_and_times_out() {
    let (_dir, project) = init(GitMode::Track);
    let held = project.lock(LOCK_WAIT).unwrap();
    let started = Instant::now();
    let err = project.lock(Duration::from_millis(300)).unwrap_err();
    let waited = started.elapsed();
    match err {
        StoreError::LockTimeout { waited } => assert_eq!(waited, Duration::from_millis(300)),
        e => panic!("{e:?}"),
    }
    assert!(waited >= Duration::from_millis(300), "{waited:?}");
    assert!(waited < Duration::from_millis(1500), "{waited:?}");
    drop(held);
    project.lock(Duration::ZERO).unwrap();
}

#[test]
fn lock_waits_for_a_holder_that_releases() {
    let (_dir, project) = init(GitMode::Track);
    let held = project.lock(LOCK_WAIT).unwrap();
    std::thread::scope(|s| {
        s.spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(held);
        });
        let started = Instant::now();
        project.lock(LOCK_WAIT).unwrap();
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(150), "{waited:?}");
        assert!(waited < LOCK_WAIT, "{waited:?}");
    });
}

#[test]
fn lock_default_wait_is_two_seconds() {
    assert_eq!(LOCK_WAIT, Duration::from_secs(2));
}

#[test]
fn lock_on_a_removed_project_is_an_io_error() {
    let (_dir, project) = init(GitMode::Track);
    fs::remove_dir_all(project.mwf_dir()).unwrap();
    assert!(matches!(
        project.lock(LOCK_WAIT).unwrap_err(),
        StoreError::Io { .. }
    ));
}

const HOLDER_ENV: &str = "MWF_STORE_TEST_HOLD_LOCK";

/// Run by `lock_is_exclusive_across_processes` in a child process: takes the lock, says so,
/// then holds it until stdin closes or the process is killed.
#[test]
#[ignore = "helper process for lock_is_exclusive_across_processes"]
fn hold_lock_in_child_process() {
    let Some(root) = std::env::var_os(HOLDER_ENV) else {
        return;
    };
    let project = Project::find(Path::new(&root)).unwrap();
    let _guard = project.lock(LOCK_WAIT).unwrap();
    println!("locked");
    std::io::stdout().flush().unwrap();
    let mut rest = Vec::new();
    std::io::stdin().read_to_end(&mut rest).unwrap();
}

#[test]
fn lock_is_exclusive_across_processes_and_released_on_exit() {
    let (_dir, project) = init(GitMode::Track);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "hold_lock_in_child_process",
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .env(HOLDER_ENV, project.root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    let mut lines = stdout.lines();
    assert!(
        lines.any(|l| l.unwrap().contains("locked")),
        "child never took the lock"
    );

    assert!(matches!(
        project.lock(Duration::from_millis(200)).unwrap_err(),
        StoreError::LockTimeout { .. }
    ));
    // The OS releases the lock when the holder dies, without any cleanup by mwf.
    child.kill().unwrap();
    child.wait().unwrap();
    project.lock(Duration::from_millis(500)).unwrap();
}

// --- pages ---

#[test]
fn write_and_read_pages() {
    let (_dir, project) = init(GitMode::Track);
    assert_eq!(project.read_page(&slug("a")).unwrap(), None);
    let guard = project.lock(LOCK_WAIT).unwrap();
    guard.write_page(&slug("b-2"), b"bee").unwrap();
    guard.write_page(&slug("a"), b"one").unwrap();
    guard.write_page(&slug("a"), b"two").unwrap();
    drop(guard);
    assert_eq!(project.read_page(&slug("a")).unwrap().unwrap(), b"two");
    assert_eq!(
        project.read_all_pages().unwrap(),
        [
            ("a".to_owned(), b"two".to_vec()),
            ("b-2".to_owned(), b"bee".to_vec())
        ]
    );
    assert_eq!(names(project.mwf_dir().join("pages")), ["a.md", "b-2.md"]);
}

#[test]
fn write_page_recreates_a_missing_pages_directory() {
    // A fresh clone has no pages/: git does not keep empty directories.
    let (_dir, project) = init(GitMode::Track);
    fs::remove_dir(project.mwf_dir().join("pages")).unwrap();
    assert_eq!(project.read_all_pages().unwrap(), Vec::new());
    project
        .lock(LOCK_WAIT)
        .unwrap()
        .write_page(&slug("a"), b"x")
        .unwrap();
    assert_eq!(project.read_page(&slug("a")).unwrap().unwrap(), b"x");
}

#[test]
fn read_all_pages_lists_md_files_only_and_keeps_invalid_names_for_lint() {
    let (_dir, project) = init(GitMode::Track);
    let pages = project.mwf_dir().join("pages");
    fs::write(pages.join("ok.md"), "1").unwrap();
    fs::write(pages.join("Bad_Name.md"), "2").unwrap();
    fs::write(pages.join("notes.txt"), "3").unwrap();
    fs::write(pages.join(".ok.md.42.0.tmp"), "4").unwrap();
    fs::create_dir(pages.join("dir.md")).unwrap();
    let stems: Vec<String> = project
        .read_all_pages()
        .unwrap()
        .into_iter()
        .map(|(stem, _)| stem)
        .collect();
    assert_eq!(stems, ["Bad_Name", "ok"]);
}

#[test]
fn index_is_replaced_whole() {
    let (_dir, project) = init(GitMode::Track);
    assert_eq!(
        project.read_index().unwrap().unwrap(),
        render_index(&[]).as_bytes()
    );
    let guard = project.lock(LOCK_WAIT).unwrap();
    guard.write_index("# long index\n- a\n- b\n").unwrap();
    guard.write_index("# short\n").unwrap();
    drop(guard);
    assert_eq!(project.read_index().unwrap().unwrap(), b"# short\n");
}

// --- trash (ADR 0026) and rename ---

#[test]
fn move_to_trash_uses_slug_and_timestamp() {
    let (_dir, project) = init(GitMode::Track);
    let guard = project.lock(LOCK_WAIT).unwrap();
    guard.write_page(&slug("old-idea"), b"content").unwrap();
    let path = guard
        .move_to_trash(&slug("old-idea"), &ts("2026-11-20T10:00:00Z"))
        .unwrap();
    assert_eq!(
        path,
        project
            .mwf_dir()
            .join("trash/old-idea.2026-11-20T10:00:00Z.md")
    );
    assert_eq!(read(&path), "content");
    assert_eq!(project.read_page(&slug("old-idea")).unwrap(), None);
}

#[test]
fn move_to_trash_never_overwrites_an_earlier_delete() {
    let (_dir, project) = init(GitMode::Track);
    let guard = project.lock(LOCK_WAIT).unwrap();
    let t = ts("2026-11-20T10:00:00Z");
    for body in ["first", "second", "third"] {
        guard.write_page(&slug("a"), body.as_bytes()).unwrap();
        guard.move_to_trash(&slug("a"), &t).unwrap();
    }
    let trash = project.mwf_dir().join("trash");
    assert_eq!(
        names(&trash),
        [
            "a.2026-11-20T10:00:00Z.1.md",
            "a.2026-11-20T10:00:00Z.2.md",
            "a.2026-11-20T10:00:00Z.md"
        ]
    );
    assert_eq!(read(trash.join("a.2026-11-20T10:00:00Z.md")), "first");
    assert_eq!(read(trash.join("a.2026-11-20T10:00:00Z.2.md")), "third");
}

#[test]
fn move_to_trash_of_a_missing_page_is_not_found() {
    let (_dir, project) = init(GitMode::Track);
    let guard = project.lock(LOCK_WAIT).unwrap();
    match guard
        .move_to_trash(&slug("nope"), &ts("2026-11-20T10:00:00Z"))
        .unwrap_err()
    {
        StoreError::PageNotFound { slug: s } => assert_eq!(s, slug("nope")),
        e => panic!("{e:?}"),
    }
}

#[test]
fn rename_page_moves_bytes_and_refuses_to_overwrite() {
    let (_dir, project) = init(GitMode::Track);
    let guard = project.lock(LOCK_WAIT).unwrap();
    guard.write_page(&slug("a"), b"A").unwrap();
    guard.write_page(&slug("b"), b"B").unwrap();
    guard.rename_page(&slug("a"), &slug("c")).unwrap();
    assert_eq!(project.read_page(&slug("a")).unwrap(), None);
    assert_eq!(project.read_page(&slug("c")).unwrap().unwrap(), b"A");

    match guard.rename_page(&slug("c"), &slug("b")).unwrap_err() {
        StoreError::PageExists { slug: s } => assert_eq!(s, slug("b")),
        e => panic!("{e:?}"),
    }
    assert_eq!(project.read_page(&slug("b")).unwrap().unwrap(), b"B");
    assert_eq!(project.read_page(&slug("c")).unwrap().unwrap(), b"A");
    assert!(matches!(
        guard.rename_page(&slug("a"), &slug("d")).unwrap_err(),
        StoreError::PageNotFound { .. }
    ));
}

// --- log.md (ADR 0029) ---

#[test]
fn append_log_and_read_the_last_lines() {
    let (_dir, project) = init(GitMode::Track);
    assert_eq!(project.read_log(10).unwrap(), Vec::<String>::new());
    let guard = project.lock(LOCK_WAIT).unwrap();
    for i in 1..=5 {
        guard
            .append_log(&format!("2026-11-20T10:00:0{i}Z new p{i} \"P{i}\""))
            .unwrap();
    }
    drop(guard);
    let log = read(project.mwf_dir().join("log.md"));
    assert_eq!(log.lines().count(), 5);
    assert!(log.ends_with("new p5 \"P5\"\n"));
    assert_eq!(
        project.read_log(2).unwrap(),
        [
            "2026-11-20T10:00:04Z new p4 \"P4\"",
            "2026-11-20T10:00:05Z new p5 \"P5\""
        ]
    );
    assert_eq!(project.read_log(100).unwrap().len(), 5);
    assert_eq!(project.read_log(0).unwrap(), Vec::<String>::new());
}

#[test]
fn append_log_repairs_a_missing_final_newline_and_a_missing_file() {
    let (_dir, project) = init(GitMode::Track);
    let path = project.mwf_dir().join("log.md");
    // A union merge can leave the last line without a newline, and blank lines in between.
    fs::write(&path, "line one\n\nline two").unwrap();
    project
        .lock(LOCK_WAIT)
        .unwrap()
        .append_log("line three")
        .unwrap();
    assert_eq!(read(&path), "line one\n\nline two\nline three\n");
    assert_eq!(
        project.read_log(5).unwrap(),
        ["line one", "line two", "line three"]
    );

    fs::remove_file(&path).unwrap();
    assert_eq!(project.read_log(5).unwrap(), Vec::<String>::new());
    project
        .lock(LOCK_WAIT)
        .unwrap()
        .append_log("again")
        .unwrap();
    assert_eq!(read(&path), "again\n");
}

#[test]
fn writes_leave_no_temp_files() {
    let (_dir, project) = init(GitMode::Track);
    let guard = project.lock(LOCK_WAIT).unwrap();
    guard.write_page(&slug("a"), b"x").unwrap();
    guard.write_index("i").unwrap();
    guard.append_log("l").unwrap();
    drop(guard);
    let mwf = project.mwf_dir();
    assert_eq!(
        names(&mwf),
        [
            ".gitignore",
            ".lock",
            "config.toml",
            "index.md",
            "log.md",
            "pages"
        ]
    );
    assert_eq!(names(mwf.join("pages")), ["a.md"]);
}
