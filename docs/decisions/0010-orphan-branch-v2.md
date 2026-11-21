# 0010 在孤儿分支 v2 上开发

- 状态：已接受（2026-11-20）
- 注：下文“待定”一节已由 [0045](0045-default-branch-v2.md) 解决。

## 决定

- Rust 版在孤儿分支 `v2` 上开发（与远端已有的 `v1` 分支对应），不继承 TS 历史。
- 初始提交只含 `docs/`、`.claude/skills/`、`LICENSE`、`.gitignore`。
- 设计决策全部完成、文档写好之后，删除 `rust-rebuild` 分支。TS 1.x 历史保留在 `main` / `v1` 上。

## 待定（已由 [0045](0045-default-branch-v2.md) 解决）

- `v2` 何时、以何种方式成为默认分支（与 `main` 的关系）。
