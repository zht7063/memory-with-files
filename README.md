# mwf: memory with files

mwf is a project-local wiki engine for coding agents. Your agent (Claude Code or Codex) writes what it learns as Markdown pages under `.mwf/` in the repository; mwf stores, checks, links, and searches them, and its hooks bring the relevant pages back into later sessions. mwf is a single static binary and never calls an LLM.

- **Plain files in git.** Pages are `.mwf/pages/<slug>.md` with a small frontmatter and standard Markdown links. Review them with `git diff`, share them with your team by committing.
- **One way in.** Every write goes through an `mwf` command that validates the page, scans it for secrets, writes it atomically under a lock, and updates `.mwf/index.md` and `.mwf/log.md`.
- **Recall without a database.** Search is in-memory BM25 over titles, summaries, tags, and bodies, with bigram tokenizing for Chinese, Japanese, and Korean text.

This is mwf 2.x, a Rust rewrite. It is a new product: it does not read 1.x data and has no MCP server, npm package, or SQLite index ([ADR 0002](docs/decisions/0002-new-product-no-compat.md), [0003](docs/decisions/0003-drop-sqlite-bm25-llm-wiki.md), [0009](docs/decisions/0009-cli-only-no-mcp.md)).

## Install

### Homebrew (macOS and Linux)

```sh
brew install zht7063/tap/mwf
```

The formula lives in [zht7063/homebrew-tap](https://github.com/zht7063/homebrew-tap) and gets stable releases only, starting with 2.0.0. Prereleases such as `2.0.0-alpha.1` are published on GitHub Releases only.

### Release archives

Each [GitHub release](https://github.com/zht7063/memory-with-files/releases) has one `.tar.xz` per platform, each with a `.sha256` file:

| Platform | Archive |
| --- | --- |
| macOS, Apple silicon | `mwf-aarch64-apple-darwin.tar.xz` |
| macOS, Intel | `mwf-x86_64-apple-darwin.tar.xz` |
| Linux, x86_64 (static, musl) | `mwf-x86_64-unknown-linux-musl.tar.xz` |
| Linux, arm64 (static, musl) | `mwf-aarch64-unknown-linux-musl.tar.xz` |

Windows is not supported. To install from an archive, check its hash, extract it, and put `mwf` on your `PATH`:

```sh
tag=v2.0.0
target=x86_64-unknown-linux-musl
base="https://github.com/zht7063/memory-with-files/releases/download/$tag"
curl -LO "$base/mwf-$target.tar.xz"
curl -LO "$base/mwf-$target.tar.xz.sha256"
sha256sum -c "mwf-$target.tar.xz.sha256"   # macOS: shasum -a 256 -c "mwf-$target.tar.xz.sha256"
tar xJf "mwf-$target.tar.xz"
install -m 755 "mwf-$target/mwf" ~/.local/bin/mwf
mwf --version
```

### Connect your agent

```sh
mwf install --host claude   # Claude Code
mwf install --host codex    # Codex
mwf install --host pi       # pi
mwf install --host antigravity   # Google Antigravity (agy CLI, App and IDE)
```

`install` adds four hooks to the host's user-level hooks file and writes the `mwf` skill. Add `--dry-run` to print the changes without writing anything. With Codex, open `/hooks` after installing and trust the mwf hooks; Codex does not run new hooks until you do.

| Host | Hooks | Skill |
| --- | --- | --- |
| `claude` | `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude`) | `$CLAUDE_CONFIG_DIR/skills/mwf/` |
| `codex` | `$CODEX_HOME/hooks.json` (default `~/.codex`) | `~/.agents/skills/mwf/` |
| `pi` | the extension `$PI_CODING_AGENT_DIR/extensions/mwf/index.ts` (default `~/.pi/agent`) | `~/.agents/skills/mwf/` |
| `antigravity` | the plugin directory `~/.gemini/config/plugins/mwf/` | `~/.agents/skills/mwf/` |

pi loads the extension when it starts, so run `/reload` in a pi session that is already open. Antigravity needs no trust step, but it blocks file edits and shell commands when a PreToolUse hook fails, so run `mwf uninstall --host antigravity` before you remove or move mwf. Codex, pi and Antigravity share the skill; uninstalling one keeps it while another is installed.

`mwf uninstall --host <host>` removes only what `install` added. Both commands keep a `<file>.mwf-bak-<time>` backup of any file whose content they change or remove, and never touch a project's `.mwf/`. Running `install` again is safe: it changes nothing when the hooks and skill are already current. Details are in [ADR 0052](docs/decisions/0052-install-and-uninstall.md).

## Quick start

Create the wiki at the root of a git repository:

```sh
mwf init
```

This creates `.mwf/` (`config.toml`, `index.md`, `log.md`, `pages/`, and a `.gitignore` for machine-local files) and adds `.mwf/log.md merge=union` to `.gitattributes`. Commit both so your team shares the wiki. Use `mwf init --local` to keep `.mwf/` out of git instead.

Once the hooks are installed, the agent reads and writes the wiki on its own. You can use the same commands by hand:

```console
$ echo 'We deploy with `make release`. It needs the `prod` profile.' |
    mwf new deploy-process --type knowledge --title "Deploy process" \
      --summary "How releases are built and shipped" --tag ops
created deploy-process
rev: 2716c7ca9460

$ mwf patch deploy-process --old "prod" --new "production"
updated deploy-process
rev: 0102ee4c0051

$ mwf search deploy release
deploy-process  knowledge  active  score 0.775  rev 0102ee4c0051
  Deploy process — How releases are built and shipped

$ mwf lint
warning[orphan] deploy-process: no other page links here; link it from a related page
errors: 0, warnings: 1
```

Each page has a `type` (`preference`, `decision`, `knowledge`, `incident`, or `task`), a `title`, a one-line `summary` of at most 120 characters, optional `tags`, and a `status` of `active` or `archived`. Link pages with ordinary Markdown links such as `[deploy](deploy-process.md)`.

### Commands

| Kind | Commands |
| --- | --- |
| Project | `init [--local]` |
| Read | `show`, `search`, `list`, `index [--rebuild]`, `log [-n N]`, `lint` |
| Write | `new`, `write --rev`, `patch`, `set`, `archive`, `unarchive`, `rename`, `delete [--unlink]` |
| Host | `install`, `uninstall`, `hook` (run by the host) |

`new` and `write` read the body from stdin. `write` replaces the body only if `--rev` still matches the page, so concurrent edits are not lost. `delete` moves the page to `.mwf/trash/` and refuses while other pages link to it, unless `--unlink` turns those links into plain text. Every command accepts `--json` and prints a single line `{"ok": true, "data": …}` or `{"ok": false, "error": {"code": …, "message": …}}`. Exit codes are 0 for success, 1 for a failed operation or a lint error, and 2 for a usage error. See [docs/cli.md](docs/cli.md) for every option and error code.

## Hooks and the skill

The hooks run as `mwf hook <event> --host <host>` with a 10-second host timeout. They do nothing in a project without `.mwf/`, and they always exit 0 so that an mwf failure never blocks the agent.

| Event | What mwf does |
| --- | --- |
| SessionStart | Injects the active `preference` pages, the table of contents, the last 10 log lines, and a lint count, within 8000 characters |
| UserPromptSubmit | Searches the prompt and injects the slug, title, and summary of up to 3 matching pages, each at most once per session |
| Stop | Reminds the agent, once per turn, to search the wiki and save what is worth keeping |
| PreToolUse | Refuses file edits under `.mwf/` and tries to catch shell commands that write there |

Injected text is wrapped in a random fence with control and bidi characters removed. The limits are set in `.mwf/config.toml`; a missing key takes its default:

```toml
[hooks]
recall_min_terms = 2            # distinct prompt words a page must match
recall_top_k = 3                # most pages injected per prompt
stop_reminder = true
session_start_max_chars = 8000
```

The `mwf` skill teaches the agent the workflow: when to search, how to add to an existing page instead of creating a duplicate, how to link related pages both ways, how to write a `task` handoff, and how to tidy the wiki. Its text is in [crates/mwf-assets/skill/](crates/mwf-assets/skill/SKILL.md).

## Safety

- **Secret scanning.** Before every write, mwf scans the text the write adds (body, frontmatter, and slug) against 19 rules for cloud and code-host API keys, payment keys, private keys, JWTs, URLs with passwords, and high-entropy `key = value` assignments. A match fails with `SECRET_DETECTED` and nothing is written. No flag, environment variable, or setting turns the scan off. `mwf lint` runs the same rules over existing pages.
- **No secrets echoed.** Errors name the rule, the line, and a masked sample such as `ghp_… (40 chars)`, never the value. A slug, title, or summary that looks like a secret is withheld from `index.md`, `log.md`, hook output, and diagnostics, and suspected secrets in rejected arguments are hidden from usage errors.
- **Guard against bypassing mwf.** The PreToolUse hook denies editor and `apply_patch` writes under `.mwf/` and best-effort detects shell writes such as redirection, `sed -i`, `mv`, `cp`, and `rm`, including inside `bash -c` scripts. This is a guard rail against mistakes, not a security boundary; `mwf lint` reports any damage that gets past it.
- **Consistent files.** Writes take `.mwf/.lock`, validate everything before touching disk, and replace files atomically (temporary file, fsync, rename). A failed write leaves no partial state. Bodies are limited to 100 KB.

See ADRs [0024](docs/decisions/0024-bypass-guard.md), [0025](docs/decisions/0025-secret-scanning.md), [0013](docs/decisions/0013-atomic-write-file-lock.md), and [0037](docs/decisions/0037-lifecycle-safety.md).

## Crate layout

The workspace is split so that the compiler enforces the layering ([docs/architecture.md](docs/architecture.md)):

| Crate | Role |
| --- | --- |
| `mwf` | The binary. Dispatches `hook` to `mwf-hooks`, `install`/`uninstall` to `mwf-lifecycle`, and everything else to `mwf-cli` |
| `mwf-cli` | Argument parsing, text and `--json` output, exit codes |
| `mwf-hooks` | Host hook protocols, fences, time budget, PreToolUse guard |
| `mwf-lifecycle` | `install` / `uninstall` of hooks and skill into host config |
| `mwf-app` | Use cases: every operation, its DTOs, and error codes. The only entry point for adapters |
| `mwf-store` | `.mwf/` layout, atomic writes, the write lock, config, session state |
| `mwf-search` | Tokenizing and BM25; pure, with no workspace dependencies |
| `mwf-domain` | Page model, frontmatter, links, patch, secret scanning, validation; pure |
| `mwf-assets` | Skill and hook text, compiled in |

Adapters depend only on `mwf-app` (and `mwf-assets`) and never on each other; `mwf-lifecycle` does not depend on `mwf-app` because it never touches wiki data. Per-crate APIs and rules are in [docs/crates/](docs/crates/).

## Development

The toolchain is pinned in `rust-toolchain.toml` (Rust 1.100). CI runs:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo deny check
.github/scripts/check-crate-graph.sh        # crates and dependencies must match docs/architecture.md
.github/scripts/check-crate-graph-test.sh
```

End-to-end tests live in `crates/mwf/tests/` and pin output with `insta` snapshots. `cargo bench -p mwf-search` runs the 5000-page search benchmark.

Releases are built by [dist](https://github.com/axodotdev/cargo-dist) from `dist-workspace.toml` when a `v*` tag matching the workspace version is pushed. `.github/workflows/release.yml` is generated: after changing the release config, run `dist generate` and commit the result ([ADR 0054](docs/decisions/0054-release-config.md)).

## Documentation

The design docs in [docs/](docs/README.md) are written in Chinese:

- [docs/cli.md](docs/cli.md): commands, options, output, and error codes
- [docs/architecture.md](docs/architecture.md): crate graph and dependency rules
- [docs/crates/](docs/crates/): responsibilities and public API of each crate
- [docs/decisions/](docs/decisions/): architecture decision records, one per decision
- [docs/implementation-plan.md](docs/implementation-plan.md): the P0–P4 plan that led to 2.0.0

## License

[MIT](LICENSE)
