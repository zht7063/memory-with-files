# src/hooks

The MWF 1.0 host-hook layer. It imports only `../mcp/index.ts` (the CLI function API, the host helpers `getSession` / `setSession` / `confirmHost`), `../skills/index.ts` (pure text) and `node:*`. `tests/layers.test.ts` enforces it.

| file           | what                                                                                 |
| -------------- | ------------------------------------------------------------------------------------ |
| `handlers.ts`  | the three hook handlers (host-neutral): `sessionStart`, `userPrompt`, `stop`         |
| `fence.ts`     | per-invocation random fence, cleaning, size cap                                      |
| `json-host.ts` | what the JSON-command-hook hosts share: stdin parsing, event check, dispatch         |
| `codex.ts`     | the Codex adapter: output format, fallback                                           |
| `claude.ts`    | the Claude Code adapter: `prompt_id` turns, Stop style, `/mwf` skip, size limits     |
| `worker.ts`    | `mwf hook <event> --worker`: answer line first, bookkeeping after                    |
| `runner.ts`    | `mwf hook <event>`: the supervisor; kills the worker at the deadline; always exits 0 |
| `budget.ts`    | the one time / size budget (lock waits < soft < deadline < host timeout)             |
| `messages.ts`  | the two user-visible one-liners                                                      |

Rules: hooks never need a terminal, never use `--confirm`, never call a destructive tool, never initialize a project, and never print anything but one JSON line. See the readme ("Hooks") for the behaviour of each event and `tests/hooks.test.ts` for the proofs.
