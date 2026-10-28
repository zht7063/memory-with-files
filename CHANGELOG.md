# Changelog

## Unreleased

### 新增

- Codex 插件新增 `Stop` hook：每个 agent 回合结束时首次触发返回 `{decision:"block", reason}`，提示 agent 自检本回合是否有值得保存到 `.mwf/` 的 preference/decision/incident/task/knowledge（带 scope 标签），有则经 `mwf_add`/`mwf_propose` 写入，并判断本回合是否有实质进展（文件改动、任务推进），有则经 `mwf_handoff` 按 task（或会话）覆盖式保存 completed/next_action/blockers/decisions（先 read 取 revision，再以 expected_revision 保存，revision 加一），纯聊天回合跳过，均不适用则静默结束；`stop_hook_active=true`、项目未启用、超时或任何失败（含空/非法/超大输入，Stop 命令带 `--stop`）均放行；宿主缺失 `stop_hook_active` 时以 (session_id, turn_id) 本地标记兜底，同一回合只 block 一次。SessionStart/UserPromptSubmit 行为不变。
- 宿主加载确认：attach/rebind 后，首次 Codex hook（SessionStart、UserPromptSubmit 等）、首次 Pi 扩展事件（受信任项目）或首次 MCP 工具调用，会在 `.mwf/local/integration.json` 的 `clients.<host>.probe.host_confirmation.<channel>`（`hook`／`extension`／`mcp`）写入确认记录（`time`、`host_version`、`host_name`、`trigger`，外加 `binding_generation`、`runtime_version`）。记录放在自由格式的 `probe` 内，`receipt_version` 仍为 3，旧的 0.3.x 运行时（严格 schema）读取、status/doctor、detach 均不受影响。Codex 的 MCP 在 `config.toml` 中独立于 hook 信任加载，因此 MCP 调用只记 `mcp` 通道，不确认 hook；只有 `hook` 触发（或 Pi 的 `extension`）才把 `probe.host_confirmed` 由 `unknown` 置为 `confirmed`。`status` / `doctor` 在 `probed.<host>.host_load` 显示 `pending`／`confirmed`、`required` 通道与各通道状态（Codex hook 载荷无版本字段，`host_version` 取 hook 载荷（若有）或同一宿主 MCP 的 clientInfo）。attach 后至少 10 分钟仍未确认时给出 `host_load.hint` 与顶层 `hints`「可能未加载或未信任」（Codex 会注明 hook 未触发、MCP 是否已连接；仅提示，不使 doctor 失败）；计时起点取 attach 探测时间与 receipt 文件 mtime 中最早的有效值，不依赖 probe，且忽略晚于当前时间的锚点（时钟回拨）。attach/rebind 重建 `probe`，旧确认随之清空，status 与 `probe.host_confirmed` 对其他 generation／runtime_version 的记录一律视为无。首次确认在 hook／MCP 内最多等待项目锁 250 ms（`withLockDeadline`），拿不到则放弃并在下一次触发重试，永不抛错。

### 修复

- Codex hook 延迟（[#30](https://github.com/zht7063/memory-with-files/issues/30)）：o200k tokenizer 改为首次精确计量时才加载（长驻 MCP/Pi 进程加载一次后复用）；hook 路径（SessionStart / UserPromptSubmit）不再加载 tokenizer，改用不依赖 tokenizer 的保守估算（`estimateTokens`：按词法 run 计价、+10% 余量，并以字节数为硬上限；在英文/代码/JSON/空白/简繁中文/日韩/西里尔/阿拉伯/泰/印地/emoji/稀有汉字等语料上不低于 o200k 精确值，属校准估算而非证明；预算的 `tokenizer_id` 为 `approx_chars_v1`）；MCP `mwf_recall` 对 30 秒内完全相同的请求（含文件指纹校验）复用结果。SessionStart/UserPromptSubmit 的 `hooks.json` timeout 由 15 秒降为 5 秒，runner 截止由 14.5 秒降为 4.5 秒（0.3.0 的临时上调撤销；数值为暂定，真机验证推迟到 1.0）；runner 按事件取截止时间（`--stop` 事件保持 14.5 秒，见 `codex/timeouts.ts`）。hook 路径的项目锁总等待上限为 2 秒（`withLockDeadline`），锁被占用时 fail-open 输出“未恢复记忆”提示，而不是被 4.5 秒 SIGKILL。新增 `scripts/measure-hook.ts` 用于测量冷启动 hook 延迟。

## 0.3.1

### 文档

- readme 更新：去掉“尚未发布”字样；新增 npm 安装与使用（`npm install -g @zht7063/mwf`、`npx @zht7063/mwf`）。代码与 0.3.0 相同。

## 0.3.0

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

- Codex hook 截止时间由 5 秒上调为 15 秒（`packaging/codex/hooks/hooks.json`），runner 由 4.7 秒上调为 14.5 秒。原因：慢主机（rain，2 核）上 js-tiktoken o200k_base 初始化约 2.8 秒，hook 实测 3.9–5.1 秒，超过旧截止，记忆未注入。每条消息都会触发 UserPromptSubmit，因此在慢机器上每条消息最多可能等待约 15 秒；快机器不受影响。 14.5 秒约为实测最慢值的 3 倍，不是已证明的上界；后续将懒加载/缓存 tokenizer 并下调截止（[#30](https://github.com/zht7063/memory-with-files/issues/30)）。

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
