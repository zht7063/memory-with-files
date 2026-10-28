---
name: mwf-status
description: Inspect MWF project connection, schema and memory health.
---

Call `mwf_status` and, when health inspection is requested, `mwf_doctor` with the absolute project root. Report connection/bootstrap status separately from data health. Report each client's `probed.<host>.host_load` as pending or confirmed (for Codex this means a hook fired; an MCP connection alone stays pending), and relay its hint (「可能未加载或未信任」) when present. Do not initialize or repair as a side effect of inspection.
