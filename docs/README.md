# MWF Rust 版开发文档

本目录记录 MWF Rust 版（全新版本，不兼容 TS 1.x）的设计与开发文档。

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 总体结构、crate 依赖图、依赖规则 | 已接受 |
| [cli.md](cli.md) | 命令、参数、输出、错误码规格 | 命令已接受，细节草案 |
| [decisions/](decisions/) | 架构决策记录（ADR），一个决策一份 | 持续追加 |
| [open-questions.md](open-questions.md) | 设计树：尚未决定的问题与其依赖 | 讨论中 |
| [crates/](crates/) | 每个 crate 的职责、公开 API、依赖、禁止事项 | 草案 |
| [implementation-plan.md](implementation-plan.md) | 目录结构与 P0–P4 实施阶段 | 草案 |

## 约定

- 决策一旦确定就写成 ADR（`decisions/NNNN-<slug>.md`），状态为 `已接受`；被推翻时新增一条 ADR 并把旧的标为 `已取代`，不改写历史。
- `architecture.md` 永远描述**当前**认可的结构，并链接到支撑它的 ADR。
- 未决问题只放在 `open-questions.md`，不在其他文档里默认假设答案。
