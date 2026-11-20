# 0005 用 Cargo workspace 多 crate 强制分层

- 状态：已接受（2026-11-20）

## 背景

1.x 靠 `tests/layers.test.ts` 用正则扫描 import 来约束分层；core 内部 26 个平铺文件之间没有分层（`read` 依赖 `write`、`doctor` 依赖 13 个模块）；`cli → mcp → hooks` 是一条转发链，hooks 要隔两层才能用到 core。

## 决定

- 每一层是一个独立 crate，crate 之间的依赖由 `Cargo.toml` 声明，编译器保证无环——反向依赖无法编译。
- 跨层依赖必须在 `Cargo.toml` 中显式出现，审查时一眼可见。
- 具体有哪些 crate、谁依赖谁，见 [architecture.md](../architecture.md)。

## 后果

- 不再需要 import 扫描测试；可选地用 `cargo-deny` / 一个小测试校验 workspace 依赖图与 architecture.md 一致。
