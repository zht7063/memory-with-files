# T07 Pi lifecycle and discovery evidence

Date: 2026-10-21. Local contract tests use Node 22.19.0 on Linux.
Contract tests are simulations and do not establish actual Pi request delivery.

| Acceptance criterion                                                     | Local evidence                                                                                                                     | Real Pi evidence                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Normal package installation discovery                                    | Package extension entry assertion; release runner uses `pi install`, never manual import                                           | not_run                                                |
| User/project same-name configuration, legacy adapter, reload/replacement | Both source paths reported; legacy package/extension detection; repeated startup, replacement callbacks and root switch assertions | not_run                                                |
| Correct version after compact/tree/resume/clear                          | New marker on every event; resume/clear/reload represented as session_start reasons                                                | not_run                                                |
| Disabled/untrusted leaves no integration state or automatic reads        | Empty uninitialized root; untrusted emits nothing and preserves receipt; release runner checks disabled discovery before init      | not_run                                                |
| Slow/failed MCP permits direct recovery                                  | Synchronous registration failure retains direct recovery; registration completion is never awaited                                 | not_run (slow host startup also not exercised locally) |

The installed Pi reports 0.73.1. Its extension type declarations contain neither
`registerMcpServer` nor `isProjectTrusted`, the APIs required by this adapter.
No compatible real Pi host or candidate release tarball was available for this
run. No actual installation, model request, compact/tree/resume/clear/reload,
hot replacement, effective host configuration precedence, or slow MCP result is
claimed. Those criteria remain partial overall.

The release runner retains normal package installation and synthetic endpoint
request observation. Its successful result is now partial, with the remaining
host scenarios explicit; the integration summary also preserves that partial
status. A synthetic endpoint is never evidence of billed model behavior.

Validation: typecheck and Prettier passed; all four Pi contract tests passed;
Python release runner syntax compilation passed. Broader lifecycle regression
checks were blocked by sandbox subprocess `EPERM` errors. The combined v2
regression run also failed; this is not recorded as a pass.
