# 0001 用 Rust 全量重写，产物为单个原生二进制

- 状态：已接受（2026-11-20）

## 背景

TS 1.x 依赖 Node ≥ 22.19 与实验性的 `node:sqlite`，hook 每次触发都要冷启动 Node。只重写一部分（例如 core/cli）意味着要长期维护 FFI 或进程边界，并仍然依赖 Node 运行时。

## 决定

core、cli、hooks、lifecycle、skills 文本、可执行入口全部用 Rust 重写，产物是一个 `mwf` 原生二进制。不保留任何 TS 运行时代码。

## 后果

- hook 启动开销降到毫秒级，不再需要 Node。
- TS 代码不再作为实现参考强制对齐（见 [0002](0002-new-product-no-compat.md)）。
