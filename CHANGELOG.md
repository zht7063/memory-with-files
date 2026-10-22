# Changelog

## 0.3.0 — 未发布

### 破坏性变更

- 移除 0.1 支持：删除 `lifecycle/migrate.ts`；0.1 项目返回 `UNSUPPORTED_LEGACY_INSTALL` 且不写文件，`migrate --from 0.1` 仅给出该错误。受管白名单不再包含 `.pi/*` 与 `.agents/skills/*`。
- receipt 升至 v3：status/doctor 仅在内存中升级 v2；`--apply` 操作先原子写入 v3 再做其他变更。v2 receipt 仍拥有 0.1 资源时一律返回 `LEGACY_RESOURCE_PENDING` 且不改动，需先用 0.2.x detach。
- **不可降级**：写成 v3 后 0.2.x 无法读取；回到 0.2.x 前须先用 0.3.0 detach，见 [UNINSTALL](packaging/UNINSTALL.md#no-downgrade-after-receipt-v3)。
- 删除转发桩 `src/storage.ts`、`setup.ts`、`pi-adapter.ts`、`protocol.ts`、`integrations/shared/identity.ts`；包入口仍为 `src/core.ts`。

### 重构

- 分层为 contracts → storage → retrieval/context → core → integrations → lifecycle → cli/mcp；`HarnessAdapter` 契约（`contracts/harness.ts`）与 `integrations/registry.ts` 统一适配器访问；封闭受管白名单 `contracts/managed-surface.ts`，仅 storage 校验写入。见 [架构](docs/architecture.md)。
- 发行产物：`zht7063-mwf-0.3.0.tgz`、`mwf-codex-0.3.0.zip`、`SHA256SUMS`、`RELEASE-STATUS.json`；产物名由 package.json 版本派生。

### 发布标准变更

- **发布判定标准已变更**为 [linux-cli-harness/1](docs/release-criteria.md)：移除真实环境验收要求（44 项证据、两个真实宿主、桌面、macOS、性能报告）；Linux 命令行中 Codex CLI 与 Pi harness 对同一 commit 全部通过即可发布。`pack:release` 依据 `releases/evidence/*.json` 计算 `publishable`，证据缺失或任一失败即为 `false`。
- 未验证项：Codex 桌面 GUI、macOS、性能报告、真实（计费）模型宿主。本版本不声称已完全验证。

### 修复

- doctor 在启用 Pi 且 `.pi/mcp.json` 存在冲突的 `mcpServers.mwf` 时报告 `OWNERSHIP_CONFLICT`（`ok: false`）（issue #20）；status 不报告此项。

相关 PR：[#17](https://github.com/zht7063/memory-with-files/pull/17)、[#21](https://github.com/zht7063/memory-with-files/pull/21), [#22](https://github.com/zht7063/memory-with-files/pull/22), [#23](https://github.com/zht7063/memory-with-files/pull/23), [#24](https://github.com/zht7063/memory-with-files/pull/24), [#25](https://github.com/zht7063/memory-with-files/pull/25), [#26](https://github.com/zht7063/memory-with-files/pull/26), [#27](https://github.com/zht7063/memory-with-files/pull/27), [#28](https://github.com/zht7063/memory-with-files/pull/28)。

发布资格以 `RELEASE-STATUS.json` 计算结果为准（见 [发布判定标准](docs/release-criteria.md)）；桌面、macOS、性能与真实宿主仍未验证。

## 0.2.0 — 未发布

- 初始化与宿主启用分离；普通操作不写规则文件。
- API 2、receipt 2、scoped handoff 1；保留 Markdown/schema 1、事务、journal、恢复和幂等。
- 持久 session/task 交接、revision/hash 冲突保护、中文检索、状态/路径资格过滤。
- 离线 o200k_base、摘要/正文分离、双预算、版本 cursor、epoch 预算预留。
- attach/rebind、分客户端 detach、所有权冲突保留、保守旧版迁移。
- Pi 原生包扩展、Codex 包内 runtime/hooks、单源发行包与校验和。
- Node 下限 22.19.0，项目许可证 MIT。

发布仍受完整 44 项验收、双宿主 GUI/工作流和性能报告约束；本条不表示已经满足发布资格。

## 0.1.0 — 迁入基线

固定上游源码与 25 项历史测试，见 docs/validation/baseline-import.md。
