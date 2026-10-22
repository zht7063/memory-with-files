# T07 Pi lifecycle and discovery evidence

> 历史记录：本文件记录 0.3.0 之前的验证结果，其中引用的文件名与路径（如 `src/storage.ts`、`src/setup.ts`、`src/pi-adapter.ts`、`src/protocol.ts`、`src/lifecycle/migrate.ts`、receipt v2）为 0.3.0 前的布局，0.3.0 已删除或替换。当前结构见 [架构](../architecture.md)。

Date: 2026-10-21. Overall T07 status: **partial**, not full pass.

Real host: `@earendil-works/pi-coding-agent` 1.3.0 on the aliyun tester,
using a synthetic model endpoint with no real API key. This establishes host
request delivery, not billed model behavior. Local contract tests remain
simulations and do not substitute for real host evidence.

| Real Pi acceptance scenario                        | Status  | Evidence                                                                                |
| -------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| Normal package discovery                           | pass    | Installed through `pi install`; extension discovered normally                           |
| MCP connection                                     | pass    | Eight `mcp__mwf__*` tools exposed to the host model request                             |
| Host tool calls and subsequent recall              | pass    | Host called `mwf_add` and `mwf_handoff`; saved memory recall verified                   |
| Disabled before init, untrusted, detached, removed | pass    | No automatic memory context or MWF tools; before-init discovery creates no memory state |
| Reinstall and rebind                               | pass    | Reinstall alone stays disabled; rebind restores memory and handoff access               |
| compact/tree/resume/clear/reload                   | not_run | Requires separate real-host scenarios                                                   |
| Conflicting configuration                          | not_run | Effective host configuration precedence unverified                                      |
| Session replacement                                | not_run | Requires a separate real-host scenario                                                  |
| Slow or failed MCP startup                         | not_run | Requires real-host fault injection                                                      |

The release-script stdin fix sets `stdin=subprocess.DEVNULL` for Pi print
sessions so the runner does not inherit stdin and hang waiting for input.
The runner reports partial and lists the remaining host scenarios explicitly.
Local lifecycle contracts cover additional simulated behavior, but those checks
do not upgrade the unrun real-host scenarios or overall T07 status.
