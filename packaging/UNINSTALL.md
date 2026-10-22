# Uninstall and file inventory (MWF 0.3.0)

Everything MWF 0.3.0 and its hosts write when installed and used, and how to remove it.
"Measured" rows were observed with a before/after `find` snapshot in a throwaway `HOME`
(Pi CLI 0.73.1, Codex CLI 0.163.0, Node 22.19.0); "code" rows are derived from source
(`src/storage`, `src/lifecycle`, `src/core`, `src/integrations`).

MWF has no global state of its own: no files under `~/.config`, `~/.cache`, XDG dirs or
`/tmp`, no `MWF_*` environment variables, no global npm bin link (unless you yourself run
`npm install -g`). Host-owned entries are listed because the host creates them on your behalf.

## Inventory

| Component                                   | Path                                                                                                                                                                  | Created by                              | Removed by                                                                                                                                     | Source                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Pi package (global)                         | `$PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent/settings.json`) → `packages[]` entry pointing at the extracted dir                                         | `pi install <dir>`                      | `pi remove <dir>` (leaves `"packages": []`)                                                                                                    | measured                          |
| Pi package (project)                        | `<project>/.pi/settings.json` → `packages[]` entry                                                                                                                    | `pi install <dir> --local`              | `pi remove <dir> --local` (leaves the file with `"packages": []`)                                                                              | measured                          |
| Pi runtime                                  | the extracted dir, e.g. `/tmp/mwf-pi/package` (Pi does **not** copy it)                                                                                               | `tar -xzf`                              | `rm -rf` that dir yourself                                                                                                                     | measured                          |
| Codex marketplace                           | `~/.codex/config.toml` → `[marketplaces.<name>]`                                                                                                                      | `codex plugin marketplace add`          | `codex plugin marketplace remove <name>`                                                                                                       | measured                          |
| Codex plugin enable                         | `~/.codex/config.toml` → `[plugins."mwf@<marketplace>"]`                                                                                                              | `codex plugin add` / GUI install        | `codex plugin remove mwf@<marketplace>` / GUI uninstall                                                                                        | measured                          |
| Codex plugin cache (runtime, hooks, skills) | `$CODEX_HOME/plugins/cache/<marketplace>/mwf/<version\|local>/` (default `CODEX_HOME=~/.codex`)                                                                       | plugin install                          | plugin remove (empty `plugins/cache/<marketplace>/` dir and `~/.codex/.tmp/marketplaces/` remain)                                              | measured                          |
| Unzipped plugin source                      | wherever you extracted `mwf-codex-0.3.0.zip`                                                                                                                          | `unzip`                                 | `rm -rf` yourself                                                                                                                              | measured                          |
| Codex project MCP                           | `<project>/.codex/config.toml` → block between `# mwf:mcp:start` / `# mwf:mcp:end` (`[mcp_servers.mwf]`)                                                              | `attach --harness codex --apply`        | `detach --harness codex --apply` (deletes the file if MWF created it and it is otherwise empty; an empty `.codex/` dir stays)                  | measured                          |
| Standalone CLI                              | `<dir>/node_modules/@zht7063/mwf` (+ `package.json`/`package-lock.json` there)                                                                                        | `npm install <tgz>`                     | `npm uninstall @zht7063/mwf` in that dir                                                                                                       | code (docs/install.md)            |
| Memory data                                 | `<project>/.mwf/` (`config.json`, `protocol.md`, `index.md`, `inbox.md`, `decisions/ knowledge/ preferences/ incidents/ tasks/ candidates/ archive/` with `.gitkeep`) | `init`                                  | keep it (your memory); `rm -rf .mwf` only if you want the data gone                                                                            | measured                          |
| Git ignore block                            | `<project>/.gitignore` → `# memory-with-files:start … end` (`.mwf/local/` or `.mwf/`)                                                                                 | `init`                                  | delete the block by hand (detach keeps it)                                                                                                     | measured                          |
| Local state dir                             | `<project>/.mwf/local/` (mode 0700)                                                                                                                                   | `init` / first locked op                | only after detach shows `disabled_clean`; `rm -rf .mwf/local`                                                                                  | measured                          |
| Project lock                                | `.mwf/local/runtime.sqlite` (empty SQLite used only as a mutex; may have `-journal` while busy)                                                                       | any locked op                           | with `.mwf/local/` — never while a host is running                                                                                             | measured                          |
| Integration receipt                         | `.mwf/local/integration.json` (per-client enabled, generation, runtime/node paths, probe evidence, owned resources)                                                   | `attach --apply`                        | stays after detach (`enabled: false`) so cleanup can resume; delete with `.mwf/local/`                                                         | measured                          |
| Session context state                       | `.mwf/local/contexts/<session_ref>.json`, `<session_ref>-state.json`                                                                                                  | Codex hooks / Pi extension each session | not removed by detach; delete with `.mwf/local/`                                                                                               | measured (Codex hooks), code (Pi) |
| Hook failure notices                        | `.mwf/local/hook-notices/<hash>.json`                                                                                                                                 | Codex hook failures                     | delete with `.mwf/local/`                                                                                                                      | code                              |
| Idempotency receipts                        | `.mwf/local/requests/<key>.json`                                                                                                                                      | write ops with an idempotency key       | delete with `.mwf/local/`                                                                                                                      | code                              |
| Migration backups                           | `.mwf/local/backups/migration-*.json`                                                                                                                                 | `migrate` (schema; 0.2.x `--from 0.1`)  | delete with `.mwf/local/`                                                                                                                      | code                              |
| Transaction journal                         | `.mwf/local/transaction.json`                                                                                                                                         | only during a commit / after a crash    | auto-recovered on next op; do not delete by hand                                                                                               | code                              |
| Temp files                                  | `*.mwf-tmp-<uuid>` beside any written file (`.mwf/`, project root, `.codex/`; 0.3 no longer scans `.pi/`)                                                             | atomic write                            | auto-cleaned at next locked op                                                                                                                 | code                              |
| 0.1 legacy only                             | `.pi/mcp.json` (`mcpServers.mwf`), `.pi/extensions/mwf.js`, `.agents/skills/{memory-with-files,mwf-init,mwf-status}/SKILL.md`, `AGENTS.md` MWF block                  | 0.1 `setup`                             | not managed by 0.3: use 0.2.x `migrate --from 0.1` / `detach --apply` first (0.3 reports UNSUPPORTED_LEGACY_INSTALL / LEGACY_RESOURCE_PENDING) | code                              |

0.3.0 (like 0.2.0) `attach --harness pi` writes nothing outside `.mwf/local/integration.json`; the Pi
extension is loaded through the package entry in Pi settings.

## Uninstall steps

Run with the runtime that is still installed, from any directory:

```sh
# 1. Disable and clean MWF-owned config (preview first, then apply)
node /abs/runtime/dist/cli.js detach --root /abs/project --harness all
node /abs/runtime/dist/cli.js detach --root /abs/project --harness all --apply
# expect "state":"disabled_clean"; on "disabled_cleanup_pending" fix the listed files and rerun

# 2a. Pi: remove the package (use --local if it was installed with --local), then the extracted dir
pi remove /abs/mwf-install/package          # and/or: pi remove /abs/mwf-install/package --local
rm -rf /abs/mwf-install

# 2b. Codex: uninstall the plugin (GUI uninstall, or CLI), then drop the marketplace if you added one
codex plugin remove mwf@<marketplace>
codex plugin marketplace remove <marketplace>
rm -rf /abs/unzipped-mwf-codex              # extracted zip, if any

# 2c. Standalone CLI, if installed
(cd /abs/cli-dir && npm uninstall @zht7063/mwf)

# 3. Optional leftovers (only after step 1 reports disabled_clean and hosts are closed)
rmdir /abs/project/.codex 2>/dev/null       # empty dir left by detach
rm -rf /abs/project/.mwf/local              # receipt, lock, session state, notices
```

Restart/reload Pi and Codex afterwards. `.mwf/` memory data (minus `local/`) can be kept and
is still readable by a standalone CLI. To remove everything, also delete `.mwf/` and the
`memory-with-files` block in `.gitignore`. Host leftovers that are not MWF's: `"packages": []`
in Pi settings files, empty `~/.codex/plugins/cache/<marketplace>/`.

## Legacy 0.1 cleanup

MWF 0.3.0 no longer manages any 0.1 file (`.pi/mcp.json`, `.pi/extensions/mwf.js`,
`.agents/skills/*`) and has no 0.1 migration code. It refuses instead of guessing:

- A project still set up by 0.1 fails every operation with `UNSUPPORTED_LEGACY_INSTALL`;
  nothing is written. `migrate --from 0.1` exists only to return this error.
- A v2 receipt that still owns non-block resources (the 0.1 `.pi/*` or skills files)
  fails every operation with `LEGACY_RESOURCE_PENDING`; nothing is changed.

Fix either case with an MWF 0.2.x runtime, then retry with 0.3.0:

```sh
# 0.1 project: migrate with 0.2.x (keeps memory data)
node /abs/mwf-0.2/dist/cli.js migrate --root /abs/project --from 0.1 --legacy-stopped --apply
# v2 receipt still owning legacy resources: detach the client(s) named in the error
node /abs/mwf-0.2/dist/cli.js detach --root /abs/project --harness pi --apply
```

Alternatively remove the 0.1 files listed in the inventory by hand. After cleanup, attach
again with 0.3.0.

## No downgrade after receipt v3

0.3.0 reads a v2 `.mwf/local/integration.json` in memory for `status`/`doctor` without
writing it. The first `--apply` operation rewrites it as receipt v3 in one atomic replace
before any other change. MWF 0.2.x cannot read a v3 receipt, so **a project cannot be
downgraded** once that happens. To go back to 0.2.x:

1. With 0.3.0, run `detach --root /abs/project --harness all --apply` and reach
   `disabled_clean`.
2. Uninstall the 0.3.0 packages (steps above), remove `.mwf/local/integration.json`
   (or all of `.mwf/local/`), keeping the rest of `.mwf/`.
3. Install 0.2.x and attach again.

## Known gaps

- `detach` leaves the receipt, session context files and an empty `.codex/` directory;
  this is by design (resumable cleanup) but means `.mwf/local/` must be removed manually.
- Codex desktop GUI uninstall was not measured; the CLI `codex plugin remove` was.
