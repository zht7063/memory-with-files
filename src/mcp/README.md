# src/mcp

The MWF 1.0 MCP layer. It sits directly on `src/cli` and may import **only** `../cli/index.ts`,
`node:*` and the MCP SDK (`@modelcontextprotocol/server`, exact pin); only `server.ts` touches the
SDK (enforced by `tests/layers.test.ts`).

- `tools.ts` – `TOOLS` (one `mwf_<command>` tool per CLI command, schemas and descriptions taken
  from the CLI) and `callTool(name, input, env)`, which maps a call onto `cli.run` and the result
  onto `{ content: [text], structuredContent: { ok, data | error }, isError? }`. It never throws.
  Hooks use `callTool` in-process; it holds no protocol code.
- `server.ts` – `serveMcp(argv, io)`: the stdio server behind `mwf mcp [--host name] [--cwd dir]`
  (low-level `Server` + `serveStdio`, so errors keep the CLI envelope). stdout is the protocol
  channel; diagnostics go to stderr.
- `index.ts` – what hooks import: the tool layer, without the SDK.

Rules (tests in `tests/mcp.test.ts`):

- **Destructive tools only preview.** `mwf_forget`, `mwf_purge`, `mwf_compact` and
  `mwf_inbox` `discard` neither advertise nor accept `confirm` / `preview_token`; they return the
  preview, its `preview_token` and `execute_with`, the shell command the user runs
  (`mwf forget --id … --confirm --preview-token …`). Only the shell executes.
- **No project path.** The project is looked up from the server's working directory (or `--cwd`)
  upwards to the `.mwf/` created by `init`; `init` itself only works at the root of a git repository.
- **Exactly once.** `request_id` is generated in `cli.run`; a replay with the same id and arguments
  returns the recorded result (`deduped: true`). Writes of one server are serialized.
- **Crash-safe.** The server does not trap SIGTERM; a process killed mid-write leaves the lock and
  the intent, which the next process recovers.
- **Host registration** (`host.local.toml`, channel `mcp`): after the first tool call, under
  `--host` or else the client's name; failures are never shown to the model.
