# 0012 工具链与目标平台

- 状态：已接受（2026-11-20）

## 决定

- Rust edition 2024，stable 工具链；MSRV 定为开工时的最新 stable，写入 `rust-toolchain.toml` 与 `Cargo.toml` 的 `rust-version`。
- 首版目标平台：
  - `aarch64-apple-darwin`、`x86_64-apple-darwin`
  - `x86_64-unknown-linux-musl`、`aarch64-unknown-linux-musl`（静态链接）
- Windows 不在首版。
