# 设计树：未决问题

讨论按轮进行。每轮只问"前置决策都已确定"的问题；确定后写成 ADR 并从这里移除。未回复的问题视为接受推荐答案。

- 第 1 轮 → ADR 0001–0007
- 第 2 轮 → ADR 0008–0015
- 第 3 轮 → ADR 0016–0022
- 第 4 轮 → ADR 0023–0031、[cli.md](cli.md)
- 第 5 轮 → ADR 0032–0037
- 第 6 轮 → ADR 0038–0039
- 第 7 轮 → ADR 0040

## 第 8 轮：落地（进行中）

| # | 问题 | 推荐 | 依赖 |
| --- | --- | --- | --- |
| R8-1 | `mwf-search` 不依赖 `mwf-domain` | 是：search 只认自己的 `Doc`，成为零依赖叶子 crate；页面 → Doc 的转换在 app | 0015 |
| R8-2 | 第三方依赖策略 | 每个 crate 的依赖白名单写在 crates/*.md；新增依赖须改文档；用 `cargo-deny` 检查许可证与重复版本 | 0005 |
| R8-3 | 跨层错误处理 | 库 crate 各自 `thiserror` 错误枚举；`mwf-app` 统一映射为 `ErrorCode`；不在库里用 `anyhow`；不 panic（hook 中额外 `catch_unwind`） | 0015, 0028 |
| R8-4 | 时钟注入 | domain / search 不取时间；app 持有可注入的 `Clock`，测试用固定时间 | 0015 |
| R8-5 | crates/*.md 的 API 草案 | 作为 P0–P2 的起点接受，实现中可调，调整回写文档 | 以上 |
| R8-6 | 实施阶段 P0–P4 | 按 implementation-plan.md | 以上 |
| R8-7 | v2 成为默认分支 | 2.0.0 发布时把 GitHub 默认分支切到 `v2`；`main` 冻结为 1.x | 0010 |
| R8-8 | 推送 v2、删除 rust-rebuild | 本轮确认后推送 `v2` 到 origin；删除本地 `rust-rebuild` 及其 worktree（需用户确认） | 0010 |
