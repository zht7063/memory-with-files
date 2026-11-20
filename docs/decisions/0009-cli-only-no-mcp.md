# 0009 只提供 CLI，不做 MCP

- 状态：已接受（2026-11-20）

## 决定

agent 通过 shell 调用 `mwf` CLI（由 skill 说明用法），不提供 MCP server。首版适配器为 `mwf-cli`、`mwf-hooks`、`mwf-lifecycle`。

## 后果

- 没有协议层，也没有异步运行时（与 [0006](0006-sync-first.md) 一致）。
- CLI 的输出必须对 agent 友好：稳定、简洁，必要时提供机器可读格式（具体见命令面设计）。
- 若将来需要 MCP，新增 `mwf-mcp` 适配器，只依赖 `mwf-app`，其他 crate 不受影响。
