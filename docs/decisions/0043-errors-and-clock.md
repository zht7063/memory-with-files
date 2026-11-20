# 0043 跨层错误处理与时钟注入

- 状态：已接受（2026-11-20）

## 错误

- 每个库 crate 用 `thiserror` 定义自己的错误枚举。
- `mwf-app` 把下层错误统一映射为 `ErrorCode`（即 [cli.md](../cli.md) 的错误码表）；适配器只认识 `ErrorCode`。
- 库 crate 不用 `anyhow`，不 panic（`unwrap` / `expect` 只出现在测试中，clippy 规则约束）。
- `mwf-hooks` 额外用 `catch_unwind` 兜底，保证任何情况下退出 0。

## 时钟

- `mwf-domain`、`mwf-search` 不取当前时间；时间戳由调用方以 `Timestamp` 传入。
- `mwf-app` 持有可注入的 `Clock`；测试使用固定时间，快照输出确定。
