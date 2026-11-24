# mwf command reference

Run the read and write commands from anywhere inside the project; they find `.mwf/` by walking up from the current directory. `mwf init` is different: it must run at the root of the git repository. Add `--json` to a read, write, `init`, `install` or `uninstall` command for one line of `{"ok":true,"data":…}` or `{"ok":false,"error":{"code":…,"message":…}}`. Exit codes: 0 success, 1 failure (or `mwf lint` found an error), 2 usage error. `mwf hook` follows the host's hook protocol instead (see below).

`<type>` is one of `preference`, `decision`, `knowledge`, `incident`, `task`. `<slug>` uses lowercase letters, digits and `-`.

## Read

| Command | Does |
| --- | --- |
| `mwf show <slug>` | Frontmatter, body, `rev`, links out and links in, with each linked page's title and summary. |
| `mwf search <query>... [--type T]... [--tag t]... [--status active\|archived\|all] [--limit N]` | BM25 search over valid pages: slug, title, summary, score and `rev` of each hit. Repeat `--type` to allow several types; repeat `--tag` to require several tags. Default: active pages, 10 hits. |
| `mwf list [--type T]... [--tag t]... [--status active\|archived\|all]` | Pages by slug, with the same filters. `list` and `search` show valid pages only; `mwf lint` reports a page file whose frontmatter does not parse. |
| `mwf index [--rebuild]` | The table of contents of the current pages; `--rebuild` also rewrites `.mwf/index.md`. |
| `mwf log [-n N]` | The last N writes (default 20). |
| `mwf lint` | Checks every page; exits 1 when there is an error. |

## Write

Every write checks the page, scans the text it adds for secret patterns, writes atomically, rebuilds `index.md` and appends one line to `log.md`. All but `delete` then print the page's `rev`, any warnings (such as links to pages that do not exist), the other pages they rewrote (`also updated`) and the pages that look related but are not linked yet. A write that would leave the page as it is changes nothing and logs nothing: it prints `unchanged <slug>` (`"changed": false` with `--json`) and the current `rev`.

| Command | Does |
| --- | --- |
| `mwf new <slug> --type T --title "…" --summary "…" [--tag t]...` | Creates a page; the body is read from stdin. |
| `mwf write <slug> --rev R` | Replaces the whole body with stdin, if `R` is still the page's rev. |
| `mwf patch <slug> --old "…" --new "…"` | Replaces the one occurrence of the old text in the body. Use `--old-file PATH` / `--new-file PATH` for text with several lines. |
| `mwf set <slug> [--title …] [--type …] [--summary …] [--tag t]... [--untag t]...` | Changes frontmatter fields; `--tag` adds a tag, `--untag` removes one. |
| `mwf archive <slug>` / `mwf unarchive <slug>` | Sets `status` to `archived` / back to `active`. |
| `mwf rename <old> <new>` | Changes the slug and rewrites every link to `old.md`. |
| `mwf delete <slug> [--unlink]` | Moves the page to `.mwf/trash/` and prints where it went (`trashed`), the pages whose links it turned into plain text (`unlinked`) and any warnings; there is no `rev`. Refused with `HAS_BACKLINKS` while other pages link to it, unless `--unlink`. Only when the user asks. |

Pass a body on stdin with a quoted heredoc, so the shell leaves it alone:

```sh
mwf new retry-policy --type decision --title "Retry only idempotent requests" \
  --summary "Why the HTTP client retries GET and PUT but never POST" --tag http <<'EOF'
## Decision

…
EOF
```

## Project and hosts

| Command | Does |
| --- | --- |
| `mwf init [--local]` | Creates `.mwf/` at the root of the git repository; `--local` keeps it out of git. Run it only when the user asks. |
| `mwf install --host <host> [--dry-run]` / `mwf uninstall --host <host> [--dry-run]` | Adds or removes the hooks and this skill for a host, in the user's home directory; `--dry-run` only prints what would change. `<host>` is `claude`, `codex`, `pi` or `antigravity` (also `agy`). The user runs these. |
| `mwf hook <event> --host <host>` | Called by the host's hooks, not by you. Reads the host's hook JSON on stdin, prints one line of the host's hook JSON (not the `{"ok":…}` envelope) and always exits 0. |

## Errors to handle

| Code | What to do |
| --- | --- |
| `NOT_INITIALIZED` | The project has no `.mwf/`. Ask the user before running `mwf init`. |
| `NOT_FOUND` | No page has that slug: `mwf search` or `mwf list` for the right one. |
| `ALREADY_EXISTS` | A page has that slug: update it, or pick another slug. |
| `INVALID_SLUG` / `INVALID_FIELD` | Fix the slug, type, title, summary (one line, at most 120 characters) or tag, and retry. |
| `REV_MISMATCH` | The page changed since you read it: `mwf show` it again, merge, and `mwf write` with the new rev. |
| `PATCH_NO_MATCH` / `PATCH_AMBIGUOUS` | The old text occurs zero times / more than once: `mwf show` the page and use a longer, exact old text. |
| `SECRET_DETECTED` | Remove the secret and write again. There is no override. |
| `HAS_BACKLINKS` | Other pages link to it: archive instead, or ask the user before `--unlink`. |
| `TOO_LARGE` | The body or patch text is over 100 KB: split the page. |
| `INVALID_PAGE` | A page file is not valid: run `mwf lint` and tell the user. |
| `LOCK_TIMEOUT` | Another write holds the lock: retry shortly. |
