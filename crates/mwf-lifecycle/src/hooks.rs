//! mwf's entries in a host's hooks document (`settings.json` for Claude Code, `hooks.json` for
//! Codex): `{"hooks": {"<Event>": [{"matcher": …, "hooks": [<handler>…]}…]}}` (ADR 0052).
//!
//! A handler is mwf's when it is a command hook whose command splits (plain POSIX quoting, no
//! expansion) into exactly `<…/mwf> hook <event> --host <this host>`. Everything else in the
//! document stays as it was.

use std::path::Path;

use crate::Host;
use crate::json::{Json, Span, Str};

/// The host's event names and the `mwf hook` event each runs (ADR 0051).
pub(crate) const EVENTS: [(&str, &str); 4] = [
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "prompt"),
    ("Stop", "stop"),
    ("PreToolUse", "pre-tool"),
];

/// The host timeout of every mwf hook, in seconds (ADR 0051).
pub(crate) const TIMEOUT_SECS: &str = "10";

/// The tools the PreToolUse guard looks at (ADR 0024); the other events take no matcher.
fn matcher(host: Host, event: &str) -> Option<&'static str> {
    (event == "PreToolUse").then_some(match host {
        Host::Claude => "Edit|Write|MultiEdit|NotebookEdit|Bash",
        Host::Codex => "apply_patch|Bash",
        // Antigravity blocks a tool when the hook fails, so only the tools the guard reads
        // (ADR 0055).
        Host::Antigravity => "write_file|edit_file|run_command",
    })
}

/// Antigravity's event names and the `mwf hook` event each runs (ADR 0055).
pub(crate) const PLUGIN_EVENTS: [(&str, &str); 4] = [
    ("SessionStart", "session-start"),
    ("PreInvocation", "prompt"),
    ("Stop", "stop"),
    ("PreToolUse", "pre-tool"),
];

/// The name of the hook group in Antigravity's plugin `hooks.json`.
const PLUGIN_GROUP: &str = "mwf";

/// The `hooks.json` of mwf's Antigravity plugin: one group, flat handler lists except
/// PreToolUse's matcher group (ADR 0055).
pub(crate) fn plugin_hooks(program: &str) -> Json {
    let events = PLUGIN_EVENTS
        .iter()
        .map(|(event, hook_event)| {
            let handler = Json::object(vec![
                ("type", Json::str("command")),
                (
                    "command",
                    Json::str(&command(program, hook_event, Host::Antigravity)),
                ),
                ("timeout", Json::Number(TIMEOUT_SECS.to_owned())),
            ]);
            let item = match matcher(Host::Antigravity, event) {
                Some(m) => Json::object(vec![
                    ("matcher", Json::str(m)),
                    ("hooks", Json::Array(vec![handler], Span::default())),
                ]),
                None => handler,
            };
            (*event, Json::Array(vec![item], Span::default()))
        })
        .collect();
    Json::object(vec![(PLUGIN_GROUP, Json::object(events))])
}

/// The status of each Antigravity event between the plugin's `hooks.json` as it was (`None`:
/// no file; a file that is not JSON counts as holding other entries) and as it will be.
pub(crate) fn plugin_events(
    old: Option<Option<&Json>>,
    new: Option<&Json>,
) -> Vec<(&'static str, Status)> {
    let entry = |doc: Option<&Json>, event: &str| {
        doc.and_then(|d| d.get(PLUGIN_GROUP))
            .and_then(|g| g.get(event))
            .cloned()
    };
    PLUGIN_EVENTS
        .iter()
        .map(|(event, _)| {
            let had = match old {
                None => None,
                Some(None) => Some(None),
                Some(Some(doc)) => entry(Some(doc), event).map(Some),
            };
            let status = match (had, entry(new, event)) {
                (None, None) => Status::Absent,
                (Some(_), None) => Status::Removed,
                (None, Some(_)) => Status::Added,
                (Some(Some(a)), Some(b)) if a.same(&b) => Status::Unchanged,
                (Some(_), Some(_)) => Status::Updated,
            };
            (*event, status)
        })
        .collect()
}

/// Whether `doc` is exactly the plugin `hooks.json` some mwf install wrote: removing it then
/// loses nothing the user wrote, so it needs no backup.
pub(crate) fn is_plugin_hooks(doc: &Json) -> bool {
    let Some(Json::Array(items, _)) = doc.get(PLUGIN_GROUP).and_then(|g| g.get("Stop")) else {
        return false;
    };
    let Some(first) = items.first().filter(|h| is_ours(h, Host::Antigravity)) else {
        return false;
    };
    let Some(words) = first.get("command").and_then(Json::as_str).and_then(split) else {
        return false;
    };
    plugin_hooks(&words[0]).same(doc)
}

/// Whether `doc` holds any of mwf's handlers for `host`, in any event.
pub(crate) fn has_ours(doc: &Json, host: Host) -> bool {
    let Some(Json::Object(events, _)) = doc.get("hooks") else {
        return false;
    };
    events.iter().any(|(_, groups)| match groups {
        Json::Array(groups, _) => groups.iter().any(|g| ours_in(g, host) > 0),
        _ => false,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Status {
    Added,
    Updated,
    Unchanged,
    Removed,
    Absent,
}

impl Status {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Status::Added => "added",
            Status::Updated => "updated",
            Status::Unchanged => "unchanged",
            Status::Removed => "removed",
            Status::Absent => "absent",
        }
    }
}

/// The command line of one hook: `program` quoted for a POSIX shell when it needs it.
pub(crate) fn command(program: &str, event: &str, host: Host) -> String {
    format!("{} hook {event} --host {}", quote(program), host.name())
}

fn quote(word: &str) -> String {
    let plain = |c: char| c.is_ascii_alphanumeric() || "_./+-:@,=%".contains(c);
    if !word.is_empty() && word.chars().all(plain) {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

/// The words of a shell command that uses only quoting: `None` when it has anything the shell
/// would expand, redirect or run separately.
pub(crate) fn split(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        d => word.push(d),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '$' | '`' => return None,
                        '\\' => match chars.next()? {
                            n @ ('"' | '\\' | '$' | '`') => word.push(n),
                            _ => return None,
                        },
                        d => word.push(d),
                    }
                }
            }
            '\\' => match chars.next()? {
                '\n' => return None,
                n => {
                    word.push(n);
                    in_word = true;
                }
            },
            ' ' | '\t' => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            c if ";&|<>()$`\n\r*?[]{}~#!".contains(c) => return None,
            c => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        words.push(word);
    }
    Some(words)
}

fn is_ours(handler: &Json, host: Host) -> bool {
    if handler.get("type").and_then(Json::as_str) != Some("command") {
        return false;
    }
    let Some(words) = handler
        .get("command")
        .and_then(Json::as_str)
        .and_then(split)
    else {
        return false;
    };
    words.len() == 5
        && Path::new(&words[0]).file_name().is_some_and(|n| n == "mwf")
        && words[1] == "hook"
        && EVENTS.iter().any(|(_, e)| *e == words[2])
        && words[3] == "--host"
        && (words[4] == host.name() || (host == Host::Antigravity && words[4] == "agy"))
}

/// mwf's matcher group for `event`: what `install` writes.
fn group(host: Host, event: &str, hook_event: &str, program: &str) -> Json {
    let handler = Json::object(vec![
        ("type", Json::str("command")),
        ("command", Json::str(&command(program, hook_event, host))),
        ("timeout", Json::Number(TIMEOUT_SECS.to_owned())),
    ]);
    let mut entries = Vec::new();
    if let Some(m) = matcher(host, event) {
        entries.push(("matcher", Json::str(m)));
    }
    entries.push(("hooks", Json::Array(vec![handler], Span::default())));
    Json::object(entries)
}

fn field<'a>(entries: &'a mut [(Str, Json)], key: &str) -> Option<&'a mut Json> {
    entries
        .iter_mut()
        .find(|(k, _)| k.value == key)
        .map(|(_, v)| v)
}

/// The handlers of each group of `event`, checked to be `[{…, "hooks": […]}…]`.
fn groups<'a>(value: &'a mut Json, event: &str) -> Result<&'a mut Vec<Json>, String> {
    let Json::Array(groups, _) = value else {
        return Err(format!("\"hooks\".\"{event}\" is not an array"));
    };
    for (i, g) in groups.iter().enumerate() {
        if !matches!(g.get("hooks"), Some(Json::Array(_, _))) {
            return Err(format!(
                "\"hooks\".\"{event}\"[{i}] is not a matcher group with a \"hooks\" array"
            ));
        }
    }
    Ok(groups)
}

fn handlers(group: &mut Json) -> Option<&mut Vec<Json>> {
    match group {
        Json::Object(entries, _) => match field(entries, "hooks") {
            Some(Json::Array(list, _)) => Some(list),
            _ => None,
        },
        _ => None,
    }
}

/// How many of mwf's handlers `group` holds.
fn ours_in(group: &Json, host: Host) -> usize {
    match group.get("hooks") {
        Some(Json::Array(list, _)) => list.iter().filter(|h| is_ours(h, host)).count(),
        _ => 0,
    }
}

/// Removes mwf's handlers from `groups` and the groups that held only them. Returns how many
/// were removed and the index (in the new list) where the first group holding one was.
fn strip(groups: &mut Vec<Json>, host: Host) -> (usize, Option<usize>) {
    let mut removed = 0;
    let mut first = None;
    let mut kept = Vec::with_capacity(groups.len());
    for mut g in std::mem::take(groups) {
        let Some(list) = handlers(&mut g) else {
            kept.push(g);
            continue;
        };
        let before = list.len();
        list.retain(|h| !is_ours(h, host));
        if list.len() < before {
            removed += before - list.len();
            first.get_or_insert(kept.len());
            if list.is_empty() {
                continue;
            }
        }
        kept.push(g);
    }
    *groups = kept;
    (removed, first)
}

fn top(doc: &mut Json) -> Result<&mut Vec<(Str, Json)>, String> {
    match doc {
        Json::Object(entries, _) => Ok(entries),
        _ => Err("the top level is not a JSON object".to_owned()),
    }
}

/// Puts mwf's group for each event in `doc`, where the first group holding an mwf handler was
/// (else at the end), and removes mwf handlers anywhere else. An event whose only mwf handler
/// is already exactly mwf's group is left alone, so a host that trusts hooks by their
/// definition keeps trusting it.
pub(crate) fn install(
    doc: &mut Json,
    host: Host,
    program: &str,
) -> Result<Vec<(&'static str, Status)>, String> {
    let top = top(doc)?;
    if field(top, "hooks").is_none() {
        top.push((Str::new("hooks"), Json::Object(Vec::new(), Span::default())));
    }
    let Some(Json::Object(hooks, _)) = field(top, "hooks") else {
        return Err("\"hooks\" is not an object".to_owned());
    };
    let mut out = Vec::new();
    for (event, hook_event) in EVENTS {
        if field(hooks, event).is_none() {
            hooks.push((Str::new(event), Json::Array(Vec::new(), Span::default())));
        }
        let Some(value) = field(hooks, event) else {
            return Err(format!("\"hooks\".\"{event}\" is missing"));
        };
        let groups = groups(value, event)?;
        let want = group(host, event, hook_event, program);
        let count: usize = groups.iter().map(|g| ours_in(g, host)).sum();
        let holder = groups.iter().find(|g| ours_in(g, host) > 0);
        if count == 1 && holder.is_some_and(|g| g.same(&want)) {
            out.push((event, Status::Unchanged));
            continue;
        }
        let (removed, at) = strip(groups, host);
        groups.insert(at.unwrap_or(groups.len()), want);
        out.push((
            event,
            if removed == 0 {
                Status::Added
            } else {
                Status::Updated
            },
        ));
    }
    Ok(out)
}

/// Removes mwf's handlers, the groups and event arrays that held only them, and `"hooks"` when
/// that leaves it empty. Everything else stays.
pub(crate) fn uninstall(doc: &mut Json, host: Host) -> Result<Vec<(&'static str, Status)>, String> {
    let top = top(doc)?;
    let absent = || EVENTS.iter().map(|(e, _)| (*e, Status::Absent)).collect();
    let Some(hooks) = field(top, "hooks") else {
        return Ok(absent());
    };
    let Json::Object(hooks, _) = hooks else {
        return Err("\"hooks\" is not an object".to_owned());
    };
    let mut out = Vec::new();
    for (event, _) in EVENTS {
        let Some(value) = field(hooks, event) else {
            out.push((event, Status::Absent));
            continue;
        };
        let groups = groups(value, event)?;
        let (removed, _) = strip(groups, host);
        if removed == 0 {
            out.push((event, Status::Absent));
            continue;
        }
        if groups.is_empty() {
            hooks.retain(|(k, _)| k.value != event);
        }
        out.push((event, Status::Removed));
    }
    if hooks.is_empty() && out.iter().any(|(_, s)| *s == Status::Removed) {
        top.retain(|(k, _)| k.value != "hooks");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{Style, parse};

    fn edit(text: &str, f: impl FnOnce(&mut Json) -> Vec<(&'static str, Status)>) -> String {
        let mut doc = parse(text).unwrap();
        f(&mut doc);
        doc.pretty(&Style::of(text))
    }

    fn statuses(v: &[(&str, Status)]) -> Vec<&'static str> {
        v.iter().map(|(_, s)| s.as_str()).collect()
    }

    #[test]
    fn quote_and_split_round_trip() {
        for word in [
            "mwf",
            "/opt/homebrew/bin/mwf",
            "/Users/A B/bin/mwf",
            "/tmp/it's/mwf",
            "/x/$HOME/`id`/mwf",
            "/x/new\nline/mwf",
            "",
        ] {
            let cmd = command(word, "stop", Host::Codex);
            assert_eq!(
                split(&cmd).unwrap(),
                [word, "hook", "stop", "--host", "codex"],
                "{cmd}"
            );
        }
        assert_eq!(quote("/opt/homebrew/bin/mwf"), "/opt/homebrew/bin/mwf");
        assert_eq!(quote("/a b/mwf"), "'/a b/mwf'");
        for shell in [
            "mwf hook stop --host codex; rm -rf ~",
            "mwf hook stop --host codex > /dev/null",
            "$MWF hook stop --host codex",
            "\"$(which mwf)\" hook stop --host codex",
            "mwf hook stop --host codex # x",
            "~/bin/mwf hook stop --host codex",
        ] {
            assert_eq!(split(shell), None, "{shell}");
        }
        assert_eq!(
            split(r#"  "/a \"b\"/mwf"  hook\ x  "#).unwrap(),
            [r#"/a "b"/mwf"#, "hook x"]
        );
    }

    #[test]
    fn recognises_only_mwf_hook_commands_for_this_host() {
        let ours = |cmd: &str, host| {
            let h = Json::object(vec![
                ("type", Json::str("command")),
                ("command", Json::str(cmd)),
            ]);
            is_ours(&h, host)
        };
        assert!(ours("mwf hook stop --host claude", Host::Claude));
        assert!(ours("'/a b/mwf' hook pre-tool --host claude", Host::Claude));
        assert!(!ours("mwf hook stop --host codex", Host::Claude));
        assert!(!ours("mwf hook stop --host claude --verbose", Host::Claude));
        assert!(!ours("mwf hook nap --host claude", Host::Claude));
        assert!(!ours("mwf-dev hook stop --host claude", Host::Claude));
        assert!(!ours("mwf hook stop --host claude && echo", Host::Claude));
        assert!(!ours("mwf lint", Host::Claude));
        let http = Json::object(vec![
            ("type", Json::str("http")),
            ("command", Json::str("mwf hook stop --host claude")),
        ]);
        assert!(!is_ours(&http, Host::Claude));
    }

    #[test]
    fn install_appends_groups_and_keeps_everything_else() {
        let text = "{\n  \"model\": \"x\",\n  \"hooks\": {\n    \"Stop\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"say done\"\n          }\n        ]\n      }\n    ],\n    \"Notification\": []\n  },\n  \"z\": 1.0\n}\n";
        let mut st = Vec::new();
        let out = edit(text, |d| {
            st = install(d, Host::Claude, "mwf").unwrap();
            st.clone()
        });
        assert_eq!(statuses(&st), ["added"; 4]);
        let doc = parse(&out).unwrap();
        let hooks = doc.get("hooks").unwrap();
        let Json::Array(stop, _) = hooks.get("Stop").unwrap() else {
            panic!()
        };
        assert_eq!(stop.len(), 2);
        assert_eq!(
            stop[0].get("hooks").unwrap().compact(),
            r#"[{"type":"command","command":"say done"}]"#
        );
        assert_eq!(
            stop[1].compact(),
            r#"{"hooks":[{"type":"command","command":"mwf hook stop --host claude","timeout":10}]}"#
        );
        assert_eq!(
            hooks.get("PreToolUse").unwrap().compact(),
            r#"[{"matcher":"Edit|Write|MultiEdit|NotebookEdit|Bash","hooks":[{"type":"command","command":"mwf hook pre-tool --host claude","timeout":10}]}]"#
        );
        // Key order: the user's keys first and where they were, new events after them.
        assert!(out.find("\"model\"") < out.find("\"hooks\""));
        assert!(out.find("\"Notification\"") < out.find("\"SessionStart\""));
        assert!(out.contains("\"z\": 1.0\n}\n"));

        // Again: nothing changes; uninstall gives back the original document.
        let again = edit(&out, |d| install(d, Host::Claude, "mwf").unwrap());
        assert_eq!(again, out);
        let back = edit(&out, |d| uninstall(d, Host::Claude).unwrap());
        assert_eq!(back, text);
    }

    #[test]
    fn install_replaces_stale_and_duplicate_handlers_in_place() {
        let text = r#"{"hooks": {"Stop": [
            {"hooks": [{"type": "command", "command": "say a"}]},
            {"hooks": [{"type": "command", "command": "/old/mwf hook stop --host codex"}, {"type": "command", "command": "say b"}]},
            {"hooks": [{"type": "command", "command": "mwf hook stop --host codex", "timeout": 10}]},
            {"hooks": [{"type": "command", "command": "mwf hook stop --host claude"}]}
        ]}}"#;
        let mut doc = parse(text).unwrap();
        let st = install(&mut doc, Host::Codex, "mwf").unwrap();
        assert_eq!(statuses(&st), ["added", "added", "updated", "added"]);
        assert_eq!(
            doc.get("hooks").unwrap().get("Stop").unwrap().compact(),
            concat!(
                r#"[{"hooks":[{"type":"command","command":"say a"}]},"#,
                r#"{"hooks":[{"type":"command","command":"mwf hook stop --host codex","timeout":10}]},"#,
                r#"{"hooks":[{"type":"command","command":"say b"}]},"#,
                r#"{"hooks":[{"type":"command","command":"mwf hook stop --host claude"}]}]"#
            )
        );
        // A new program path updates the handler where it is.
        let st = install(&mut doc, Host::Codex, "/a b/mwf").unwrap();
        assert_eq!(statuses(&st), ["updated"; 4]);
        assert!(
            doc.compact()
                .contains(r#""command":"'/a b/mwf' hook stop --host codex""#)
        );
    }

    #[test]
    fn uninstall_removes_only_mwf_and_what_it_emptied() {
        let text = r#"{"hooks": {
            "Stop": [{"hooks": []}, {"hooks": [{"type": "command", "command": "mwf hook stop --host codex"}, {"type": "command", "command": "say b"}]}],
            "PreToolUse": [{"matcher": "apply_patch|Bash", "hooks": [{"type": "command", "command": "mwf hook pre-tool --host codex"}]}],
            "SessionStart": [{"hooks": [{"type": "command", "command": "mwf hook session-start --host claude"}]}]
        }}"#;
        let mut doc = parse(text).unwrap();
        let st = uninstall(&mut doc, Host::Codex).unwrap();
        assert_eq!(statuses(&st), ["absent", "absent", "removed", "removed"]);
        assert_eq!(
            doc.compact(),
            concat!(
                r#"{"hooks":{"Stop":[{"hooks":[]},{"hooks":[{"type":"command","command":"say b"}]}],"#,
                r#""SessionStart":[{"hooks":[{"type":"command","command":"mwf hook session-start --host claude"}]}]}}"#
            )
        );
        let mut empty = parse(r#"{"hooks": {"Stop": []}}"#).unwrap();
        assert_eq!(
            statuses(&uninstall(&mut empty, Host::Codex).unwrap()),
            ["absent"; 4]
        );
        assert_eq!(empty.compact(), r#"{"hooks":{"Stop":[]}}"#);
    }

    #[test]
    fn refuses_documents_of_the_wrong_shape() {
        for (text, why) in [
            ("[]", "the top level is not a JSON object"),
            (r#"{"hooks": []}"#, "\"hooks\" is not an object"),
            (
                r#"{"hooks": {"Stop": {}}}"#,
                "\"hooks\".\"Stop\" is not an array",
            ),
            (
                r#"{"hooks": {"Stop": [{"hooks": "x"}]}}"#,
                "\"hooks\".\"Stop\"[0] is not a matcher group with a \"hooks\" array",
            ),
            (
                r#"{"hooks": {"PreToolUse": [3]}}"#,
                "\"hooks\".\"PreToolUse\"[0] is not a matcher group",
            ),
        ] {
            let err = install(&mut parse(text).unwrap(), Host::Claude, "mwf").unwrap_err();
            assert!(err.contains(why), "{text}: {err}");
            let err = uninstall(&mut parse(text).unwrap(), Host::Claude).unwrap_err();
            assert!(err.contains(why), "{text}: {err}");
        }
    }
}
