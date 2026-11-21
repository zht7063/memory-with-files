# 0044 实施阶段与分支安排

- 状态：已接受（2026-11-20）；“发布 2.0.0 时切换默认分支”一条被 [0045](0045-default-branch-v2.md) 取代

## 决定

- 按 [implementation-plan.md](../implementation-plan.md) 分 P0–P4 实施；P2 结束发 `2.0.0-alpha.1`，P4 结束发 `2.0.0`。
- [crates/](../crates/) 中的 API 草案作为 P0–P2 的起点；实现中可调整，调整须回写文档。设计文档留在 `docs/crates/`，不挪入各 crate 目录。
- `v2` 推送到 origin，作为 Rust 版的开发主线；各阶段 PR 合入 `v2`。
- 发布 2.0.0 时把 GitHub 默认分支切到 `v2`；`main` 冻结为 1.x，只修严重问题。
- 设计讨论结束后删除本地 `rust-rebuild` 分支（它只多一个安装 skills 的提交，内容已包含在 `v2` 中）。
