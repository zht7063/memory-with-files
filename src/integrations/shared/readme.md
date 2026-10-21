# 宿主共用接入机制

状态：已实现。

## 文件与导出

- `binding.ts`：`discover`（从 cwd 找最近 MWF 项目）、`Binding` 类型、`checkBinding`（核对 receipt 中 enabled、root、generation 及可选的 runtime）；转导出 `storage/receipt.ts`。
- `context.ts`（T04 状态机）：`beginContext`/`prepareContext`/`finishContext`。每会话状态存于 `.mwf/local/contexts/<session_ref>-state.json`（epoch、已用 reference_tokens/bytes、输出记录 pending/submitted/accepted/unknown、诊断）。所有操作在项目锁内并前后复核绑定；新进入时遗留 pending 转为 unknown 且保留额度和去重键；reset 时重建 epoch。事件预期见 `docs/validation/context-events.md`。
- `identity.ts`：仅转导出 `src/core/identity.ts`（T05 会话身份）。

## 约束

- 不从 MCP 连接 ID 猜会话；不保存完整 prompt 或凭据。
- 真实宿主请求观测尚未验收（context-events.md 标为后续工作）。

## 依据

- 构建规范 §5、§7.5、§12、§14；L05–L07、L11、S06、S09、S11、R10。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
