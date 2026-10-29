# src/cli

The MWF 1.0 command layer. It sits directly on `src/core` and may import **only** `../core/index.ts`
(the public core API; enforced by `tests/layers.test.ts`).

- `commands.ts` – one entry per command (`init`, `bootstrap`, `recall`, `get`, `add`, `propose`,
  `edit`, `handoff`, `status`, `doctor`, `inbox`, `compact`, `reindex`, `forget`, `restore`,
  `purge`): description, access class (`read` / `write` / `destructive`), a JSON-Schema input
  description, and the call into core. The MCP layer (later PR) turns each into `mwf_<name>`.
- `index.ts` – the structured functions (`status()`, `add()`, ...) and `run(name, input, env)`.
  They validate input, find the project (`cwd` upwards), call core and return
  `{ ok: true, data } | { ok: false, error: { code, message, details } }`; they never throw.
- `main.ts` / `render.ts` – the command line: `status`, `recall`, `doctor`, and the two writes
  `add` and `handoff` (flags or stdin, `--json`, a request_id that is always sent and printed).
  Every other write goes through MCP tools only.
- `../bin/mwf.ts` – the `mwf` executable: dispatch only.

Exit codes: `0` ok, `1` the command failed (incl. a refused write, or `doctor` found errors), `2` usage error or invalid input.
