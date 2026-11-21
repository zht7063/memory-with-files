# 实施计划

> 状态：已接受（[0044](decisions/0044-implementation-and-branches.md)）。每个阶段结束时 `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test` 全绿。

## 目录结构

```
Cargo.toml              workspace，统一 version = "2.0.0-alpha.N"、edition = "2024"、rust-version
rust-toolchain.toml     固定 MSRV（1.100.0，0012）
clippy.toml             测试中允许 unwrap / expect / panic（0043）
deny.toml               cargo-deny 策略（0046）
crates/
  mwf-domain/  mwf-search/  mwf-store/  mwf-app/
  mwf-cli/  mwf-hooks/  mwf-lifecycle/  mwf-assets/
  mwf/                  bin；tests/ 下是端到端测试
docs/
.github/workflows/      ci.yml（P0）、release.yml（P4，由 dist 生成）
.github/scripts/        check-crate-graph.sh：cargo metadata 的 workspace 内依赖（含 dev）须与 architecture.md 的 mermaid 边完全一致
```

P0 的空 crate 用 `use <dep> as _;` 声明依赖边（Cargo 默认对未使用的依赖告警），真正使用后删除。

## 阶段

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| **P0 骨架** | workspace、全部空 crate 与依赖边、`rust-toolchain.toml`、CI（fmt / clippy / test / `cargo-deny`（`deny.toml`，见 [0046](decisions/0046-pre-p0-doc-fixes.md)）/ 依赖图检查：解析 `cargo metadata`，断言与 architecture.md 一致） | CI 绿；违反依赖规则的 PR 会失败 |
| **P1 纯计算** | domain：Slug、frontmatter、链接、patch、secret 扫描、index/log 渲染、validate；search：分词、BM25、similar_to、5000 页基准 | 单元测试覆盖全部规则；基准 < 100 ms |
| **P2 可用的 CLI** | store：项目定位、init、原子写、锁、配置、log、trash；app：全部读写操作与 lint；cli：全部命令与 `--json`；端到端 + 快照测试 | 在真实仓库里能 `init` / `new` / `patch` / `search` / `lint`；发 `2.0.0-alpha.1`（仅 GitHub Release，手动） |
| **P3 hooks 与 skill** | hooks：四个事件 × 两个宿主、fence、预算、会话状态、PreToolUse 守卫；assets：`mwf` skill 文本 | 用假宿主输入的端到端测试；在 Claude Code、Codex 里手动走一遍 |
| **P4 安装与发布** | lifecycle：install / uninstall / dry-run；`dist` 配置、release 工作流、Homebrew tap | `brew install <owner>/tap/mwf && mwf install --host claude` 可用；发 `2.0.0` |

## 每个阶段的工作方式

- 一个阶段一个或多个 PR，合入 `v2`。
- 实现与文档冲突时先改文档（新增 ADR），再改代码。
- `docs/crates/*.md` 中的 API 是起点，实现中可以调整，但调整要回写文档。
