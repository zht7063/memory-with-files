//! Session state `.mwf/.state/<id>.json` against real directories (ADRs 0034, 0051).

#![allow(clippy::unwrap_used, clippy::panic)]

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use mwf_store::{GitMode, Project, SESSION_MAX_AGE, SessionState, StoreError};
use tempfile::TempDir;

fn project() -> (TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    let project = Project::init(&root, GitMode::Track).unwrap();
    (dir, project)
}

fn state_dir(p: &Project) -> PathBuf {
    p.mwf_dir().join(".state")
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn state(recalled: &[&str], turn: Option<&str>) -> SessionState {
    SessionState {
        recalled: recalled.iter().map(|s| (*s).to_owned()).collect(),
        reminded_turn: turn.map(str::to_owned),
    }
}

fn set_age(path: &Path, age: Duration) {
    let file = File::open(path).unwrap();
    file.set_modified(SystemTime::now() - age).unwrap();
}

#[test]
fn state_dir_is_created_on_first_save_and_round_trips() {
    let (_dir, p) = project();
    assert!(!state_dir(&p).exists(), "init must not create .state/");
    let s = p.session("abc-123").unwrap();
    assert_eq!(s.load().unwrap(), SessionState::default());
    // Loading does not create anything.
    assert!(!state_dir(&p).exists());

    let saved = state(&["a", "b"], Some("turn-1"));
    s.save(&saved).unwrap();
    assert_eq!(names(&state_dir(&p)), ["abc-123.json"]);
    assert_eq!(s.load().unwrap(), saved);
    // A fresh handle on the same id sees it; another id does not.
    assert_eq!(p.session("abc-123").unwrap().load().unwrap(), saved);
    assert_eq!(
        p.session("other").unwrap().load().unwrap(),
        SessionState::default()
    );
}

#[test]
fn file_format_is_versioned_json() {
    let (_dir, p) = project();
    p.session("s")
        .unwrap()
        .save(&state(&["x"], Some("t")))
        .unwrap();
    let text = fs::read_to_string(state_dir(&p).join("s.json")).unwrap();
    assert_eq!(
        text,
        "{\"version\":1,\"recalled\":[\"x\"],\"reminded_turn\":\"t\"}\n"
    );
}

#[test]
fn corrupt_or_foreign_files_read_as_empty_and_are_replaced() {
    let (_dir, p) = project();
    let s = p.session("s").unwrap();
    s.save(&SessionState::default()).unwrap();
    let path = state_dir(&p).join("s.json");
    for bad in [
        &b""[..],
        b"{",
        b"not json",
        b"\xff\xfe",
        b"[1,2]",
        b"{\"recalled\":[\"a\"]}",
        b"{\"version\":2,\"recalled\":[\"a\"]}",
        b"{\"version\":1,\"recalled\":\"a\"}",
    ] {
        fs::write(&path, bad).unwrap();
        assert_eq!(
            s.load().unwrap(),
            SessionState::default(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
    // Unknown keys of the same version are ignored; missing ones take defaults.
    fs::write(
        &path,
        b"{\"version\":1,\"recalled\":[\"a\"],\"later\":true}",
    )
    .unwrap();
    assert_eq!(s.load().unwrap(), state(&["a"], None));
    // Saving over a corrupt file works.
    fs::write(&path, b"{").unwrap();
    s.save(&state(&["b"], None)).unwrap();
    assert_eq!(s.load().unwrap(), state(&["b"], None));
}

#[test]
fn session_ids_cannot_leave_the_state_directory() {
    let (_dir, p) = project();
    for id in ["../../escape", "/tmp/escape", "..\\escape", "a/../../b"] {
        let s = p.session(id).unwrap();
        s.save(&state(&["x"], None)).unwrap();
        assert!(!s.id().contains('/') && !s.id().contains('.'), "{}", s.id());
    }
    let mut files = names(&state_dir(&p));
    files.sort();
    assert_eq!(files, ["ab.json", "escape.json", "tmpescape.json"]);
    assert!(!p.root().join("escape.json").exists());
    assert!(!p.mwf_dir().join("escape.json").exists());
    // Ids with no safe character mean "no session".
    for id in ["", "...", "/", "会话"] {
        assert!(p.session(id).is_none(), "{id:?}");
    }
}

#[cfg(unix)]
#[test]
fn symlinked_state_dir_or_file_is_refused_and_never_followed() {
    use std::os::unix::fs::symlink;
    let (dir, p) = project();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, state_dir(&p)).unwrap();
    let s = p.session("s").unwrap();
    let wrong = |r: Result<(), StoreError>| matches!(r, Err(StoreError::WrongFileType { .. }));
    assert!(wrong(s.load().map(drop)));
    assert!(wrong(s.save(&state(&["x"], None))));
    assert!(wrong(s.remove()));
    assert!(wrong(p.prune_sessions(SystemTime::now()).map(drop)));
    assert!(names(&outside).is_empty());

    // A symlinked state file inside a real .state/.
    fs::remove_file(state_dir(&p)).unwrap();
    fs::create_dir(state_dir(&p)).unwrap();
    let target = outside.join("target.json");
    fs::write(&target, b"{\"version\":1,\"recalled\":[\"leak\"]}").unwrap();
    symlink(&target, state_dir(&p).join("s.json")).unwrap();
    assert!(wrong(s.load().map(drop)));
    assert!(wrong(s.save(&state(&["x"], None))));
    assert!(wrong(s.remove()));
    assert_eq!(
        fs::read(&target).unwrap(),
        b"{\"version\":1,\"recalled\":[\"leak\"]}"
    );

    // .state as a regular file.
    fs::remove_dir_all(state_dir(&p)).unwrap();
    fs::write(state_dir(&p), b"x").unwrap();
    assert!(wrong(s.load().map(drop)));
    assert!(wrong(s.save(&state(&["x"], None))));
}

#[test]
fn a_replaced_mwf_is_changed() {
    let (_dir, p) = project();
    let s = p.session("s").unwrap();
    fs::rename(p.mwf_dir(), p.root().join("moved")).unwrap();
    fs::create_dir(p.mwf_dir()).unwrap();
    assert!(matches!(s.load(), Err(StoreError::Changed { .. })));
    assert!(matches!(
        s.save(&SessionState::default()),
        Err(StoreError::Changed { .. })
    ));
    assert!(names(&p.mwf_dir()).is_empty());
}

#[test]
fn saves_are_atomic_and_leave_no_temp_files() {
    let (_dir, p) = project();
    let big: Vec<String> = (0..2000).map(|i| format!("page-{i}")).collect();
    let a = SessionState {
        recalled: big.clone(),
        reminded_turn: Some("a".into()),
    };
    let b = SessionState {
        recalled: big[..10].to_vec(),
        reminded_turn: Some("b".into()),
    };
    let s = p.session("s").unwrap();
    s.save(&a).unwrap();
    std::thread::scope(|scope| {
        for st in [&a, &b] {
            let s = s.clone();
            scope.spawn(move || {
                for _ in 0..20 {
                    s.save(st).unwrap();
                }
            });
        }
        scope.spawn(|| {
            for _ in 0..200 {
                let seen = s.load().unwrap();
                assert!(seen == a || seen == b, "torn read");
            }
        });
    });
    assert_eq!(names(&state_dir(&p)), ["s.json"]);
}

#[test]
fn remove_deletes_only_this_session() {
    let (_dir, p) = project();
    let s = p.session("s").unwrap();
    s.remove().unwrap(); // nothing there yet
    s.save(&state(&["a"], None)).unwrap();
    p.session("t").unwrap().save(&state(&["b"], None)).unwrap();
    s.remove().unwrap();
    s.remove().unwrap();
    assert_eq!(s.load().unwrap(), SessionState::default());
    assert_eq!(names(&state_dir(&p)), ["t.json"]);
}

#[test]
fn prune_removes_files_seven_days_old_by_mtime() {
    let (_dir, p) = project();
    assert_eq!(p.prune_sessions(SystemTime::now()).unwrap(), 0); // no .state/ yet
    for id in ["fresh", "almost", "old", "ancient"] {
        p.session(id).unwrap().save(&state(&[id], None)).unwrap();
    }
    let dir = state_dir(&p);
    let stale_tmp = dir.join(".old.json.1.2.tmp");
    fs::write(&stale_tmp, b"partial").unwrap();
    fs::create_dir(dir.join("subdir")).unwrap();
    let hour = Duration::from_secs(3600);
    set_age(&dir.join("almost.json"), SESSION_MAX_AGE - hour);
    set_age(&dir.join("old.json"), SESSION_MAX_AGE + hour);
    set_age(&dir.join("ancient.json"), SESSION_MAX_AGE * 10);
    set_age(&stale_tmp, SESSION_MAX_AGE * 2);
    set_age(&dir.join("subdir"), SESSION_MAX_AGE * 2);

    assert_eq!(p.prune_sessions(SystemTime::now()).unwrap(), 3);
    assert_eq!(names(&dir), ["almost.json", "fresh.json", "subdir"]);
    // Age is the file's mtime, not anything stored in it: saving refreshes it.
    assert_eq!(
        p.session("old").unwrap().load().unwrap(),
        SessionState::default()
    );
    // A clock behind the files removes nothing.
    let past = SystemTime::now() - SESSION_MAX_AGE * 100;
    assert_eq!(p.prune_sessions(past).unwrap(), 0);
    assert_eq!(SESSION_MAX_AGE, Duration::from_secs(7 * 86_400));
}

#[cfg(unix)]
#[test]
fn prune_leaves_symlinks_and_their_targets_alone() {
    use std::os::unix::fs::symlink;
    let (dir, p) = project();
    p.session("s")
        .unwrap()
        .save(&SessionState::default())
        .unwrap();
    let target = dir.path().join("keep.json");
    fs::write(&target, b"keep").unwrap();
    set_age(&target, SESSION_MAX_AGE * 2);
    symlink(&target, state_dir(&p).join("link.json")).unwrap();
    let later = SystemTime::now() + SESSION_MAX_AGE * 3;
    assert_eq!(p.prune_sessions(later).unwrap(), 1);
    assert_eq!(names(&state_dir(&p)), ["link.json"]);
    assert_eq!(fs::read(&target).unwrap(), b"keep");
}

#[test]
fn state_files_are_ignored_by_git_rules() {
    // `.state/` is machine-local (ADR 0048).
    assert!(mwf_store::MWF_GITIGNORE.lines().any(|l| l == "/.state/"));
}
