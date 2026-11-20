# 实施计划（草案）

> 状态：草案（第 8 轮评审）。每个阶段结束时 `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test` 全绿。

## 目录结构

```
Cargo.toml              workspace，统一 version = "2.0.0-alpha.N"、edition = "2024"、rust-version
rust-toolchain.toml
crates/
  mwf-domain/  mwf-search/  mwf-store/  mwf-app/
  mwf-cli/  mwf-hooks/  mwf-lifecycle/  mwf-assets/
  mwf/                  bin；tests/ 下是端到端测试
docs/
.github/workflows/      ci.yml（P0）、release.yml（P4，由 dist 生成）
```

## 阶段

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| **P0 骨架** | workspace、全部空 crate 与依赖边、`rust-toolchain.toml`、CI（fmt / clippy / test / 依赖图检查：解析 `cargo metadata`，断言与 architecture.md 一致） | CI 绿；违反依赖规则的 PR 会失败 |
| **P1 纯计算** | domain：Slug、frontmatter、链接、patch、secret 扫描、index/log 渲染、validate；search：分词、BM25、similar_to、5000 页基准 | 单元测试覆盖全部规则；基准 < 100 ms |
| **P2 可用的 CLI** | store：项目定位、init、原子写、锁、配置、log、trash；app：全部读写操作与 lint；cli：全部命令与 `--json`；端到端 + 快照测试 | 在真实仓库里能 `init` / `new` / `patch` / `search` / `lint`；发 `2.0.0-alpha.1`（仅 GitHub Release，手动） |
| **P3 hooks 与 skill** | hooks：四个事件 × 两个宿主、fence、预算、会话状态、PreToolUse 守卫；assets：`mwf` skill 文本 | 用假宿主输入的端到端测试；在 Claude Code、Codex 里手动走一遍 |
| **P4 安装与发布** | lifecycle：install / uninstall / dry-run；`dist` 配置、release 工作流、Homebrew tap | `brew install <owner>/tap/mwf && mwf install --host claude` 可用；发 `2.0.0` |

## 每个阶段的工作方式

- 一个阶段一个或多个 PR，合入 `v2`。
- 实现与文档冲突时先改文档（新增 ADR），再改代码。
- `docs/crates/*.md` 中的 API 是起点，实现中可以调整，但调整要回写文档。

## 待定（第 8 轮）

- 第三方依赖策略、跨层错误处理、v2 何时成为默认分支、推送与删除 `rust-rebuild` 的时机。
