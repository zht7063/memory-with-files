# T09 host session validation

2026-10-21: local simulation only. Real host results below are `not_run`.
No release/GUI pass is inferred from adapter mocks, filesystem installation fixtures,
standalone probes, or Python syntax checks. L08/G10 remain partial until these runs.

| Surface | Result | Missing evidence |
| --- | --- | --- |
| Pi CLI | not_run | Actual package removal, restart and recovery |
| Codex bundled CLI/app-server | not_run | Actual plugin removal, restart and recovery |
| Pi interactive UI | not_run | Supported reload, registration and request observation |
| Codex desktop GUI | not_run | Normal trust, uninstall, reload and recovery |
| Both hosts on the same project | not_run | Independent live host operation |

## Preparation for every run

1. Record OS, Node executable/version, both host versions (desktop build separately),
   candidate SHA256, canonical project root, installed runtime paths and timestamps.
   Use an isolated project; install the same candidate in both hosts by the normal
   package mechanisms in `docs/install.md`. Initialize once, attach both clients,
   grant normal project/hook trust, and start both hosts in this project.
2. Add a preference with summary `T09_ORIGINAL` and body `Original Markdown 正文`.
   In each host save a session handoff using its observed `session_ref`, and a task
   handoff with task ID `t09-recovery`, expected revision 0 and a unique request ID.
   Use `mwf_handoff` with `action: save` and
   `data: {goal: "T09_HANDOFF", next_action: "Resume original"}`. Record session refs.
3. Snapshot every Markdown file under `.mwf`, `.mwf/local/handoffs/` and the original
   `.mwf/local/contexts/<session_ref>.json` files as bytes outside the project.
   Do not delete `.mwf/local`: it holds identity mappings and scoped handoffs.
4. In each host call `mwf_status`, recall the marker, and explicitly read each
   handoff. Keep one MCP connection alive, recording its binding generation.
   Capture supported tool-list and subsequent model-request observations.

## CLI sessions (separate from GUI)

1. Run `node <installed-runtime>/dist/cli.js detach --root <project> --harness pi --apply`.
   Before restarting Pi, call status and a write through its retained MCP connection;
   both must fail with disabled/stale binding and no mutation. Submit a Pi prompt:
   no MWF context should be emitted and its dynamic tools should unregister at the
   next adapter event. Codex must still recall, save a new memory, and emit that
   memory on a subsequent model request. Record outputs, not just exit codes.
2. Run `pi remove <installed-pi-package> --local --approve`; exit Pi completely and
   restart in the same project. Record no MWF tools and no automatic memory output.
   Run `pi install <installed-pi-package> --local --approve`; restart again before
   attaching: still no MWF tools/context. Run attach with `--harness pi --apply`
   from that installed runtime, restart, and confirm recall and original session/task
   handoff reads. The retained pre-detach connection must still reject requests.
3. Repeat steps 1–2 for Codex while Pi stays enabled. Use
   `node <installed-plugin>/runtime/dist/cli.js detach --root <project> --harness codex --apply`,
   `codex plugin remove mwf@<marketplace> --json`, quit/restart Codex, then
   `codex plugin add mwf@<marketplace> --json`. Resolve the new installed cache path;
   run its attach command with `--plugin-root <new-installed-plugin> --apply`.
   Before attach, verify empty hook context and no MWF tools in a fresh session.
   After attach/restart verify new tools, marker and handoffs; old connection rejected.
4. Compare every original snapshot byte-for-byte; new memories may add files but
   cannot change original records/handoffs (the generated index may rebuild). Read original Markdown directly and through `get`;
   read saved session handoffs with their original refs and task handoff by ID.
5. For repeatable synthetic CLI runs after `npm run pack:release`, run
   `python3 tests/integrations/release/pi.py <absolute-pi-binary>` and
   `python3 tests/integrations/release/codex.py <absolute-codex-binary>`.
   Preserve their evidence directories. These run hosts independently and do not
   replace the shared-project live-host check above. Codex's test trust bypass is
   not evidence of normal trust or desktop behavior. If a CLI flag differs, record
   the host help output and exact supported replacement; do not mark an unrun step pass.

## GUI / interactive sessions

1. Repeat preparation in normal Pi interactive UI and Codex desktop. Record each
   product's displayed version, install/trust UI actions and supported reload action.
   Do not use Codex's test-only hook trust bypass. Record the GUI Node resolution.
2. Detach Pi using its installed CLI while both UI sessions remain open. Attempt a
   retained tool call, then submit a prompt; capture disabled/stale response, absence
   of MWF context, tool removal on next event, and continued Codex tool/context use.
   Remove Pi package through its normal package command, invoke its supported reload
   or fully quit/reopen, and capture the tool list and next request. Reinstall, reload
   before attach (still disabled), attach Pi and reload; read original data/handoffs.
3. Detach Codex using its installed runtime while Pi stays active. In Codex desktop's
   normal plugin management UI uninstall MWF, reload or fully quit/reopen, and capture
   plugin list, tool list and next request. Reinstall through that UI and trust normally;
   reload before attach (still disabled). Resolve the new installed runtime, attach
   Codex, reload and verify original Markdown/session/task reads and Pi continuity.
4. Repeat byte comparisons and retained-connection rejection after re-attach.
   Store GUI screenshots/logs and CLI transcripts separately. If the product cannot
   expose request context or retain a connection, mark that observation `not_run`
   with the missing capability; tool absence alone does not prove context absence.

## Local execution evidence

Node 22.19.0 on 2026-10-21: `npm run typecheck` and `npm run format:check`
passed. `node --experimental-strip-types tests/t09-lifecycle.test.ts` passed both
node:test scenarios. Package removal/reload is a filesystem/adapter simulation,
not a real host operation. The existing lifecycle subprocess tests hit
`spawnSync ... EPERM` in this sandbox; `npm test` did not pass. No real host
release script or GUI session was run. Python release scripts were syntax checked.
