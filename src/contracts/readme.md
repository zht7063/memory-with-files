# 共用契约

状态：已实现（T01 起）。最底层，只依赖 zod 与本目录文件。

## 文件与导出

- `version.ts`：`RUNTIME_VERSION`（从包内 package.json 读取）、`API_VERSION = 2`。
- `error.ts`：`MWFError`（带 code 的错误类型，如 `INVALID_INPUT`、`RUNTIME_MISMATCH`、`CONTEXT_REQUIRED`）。
- `result.ts`：`failure()`，把异常转换为统一的失败结果（ok=false、error.code/message、runtime/api 版本）。
- `host-confirmation.ts`：宿主加载确认的纯函数契约——`requiredChannel`（Codex=hook，Pi=extension）、`currentConfirmation`（只认当前 generation／runtime_version 的 `probe.host_confirmation`）、`hostLoad`（status/doctor 与 `probe.host_confirmed` 共用的判定）。记录放在自由格式的 `probe` 内以兼容旧运行时的严格 receipt schema。
- `records.ts`：schema 1 记录契约——`SCHEMA_VERSION`、`SCOPE_KEYS`、`RECORD_DIRS`/`ALL_DIRS`、`TYPES`、`typeSchema`/`scopeSchema`、`parseRecord`、`validateRecord`、`render`、`boundaries`（适用／失效边界解析）、`secrets`/`requireSafe`（凭据拦截）、旧 AGENTS 块 marker 与 `managed()`。

各操作的输入 schema 位于 `src/core/index.ts` 的 `schemas`，receipt schema 位于 `src/storage/receipt.ts`，不在本目录。

## 约束

- 分层（`tests/architecture.test.ts` 强制）：contracts → storage / retrieval / context → core → lifecycle / integrations / 接口入口（`src/cli.ts`、`src/mcp.ts`）。测试只检查 `src/core/` 与 `src/contracts/` 的传递依赖：不得导入 `integrations/`、`lifecycle/` 或宿主 SDK（`@modelcontextprotocol/*`、`@mariozechner/*`、`@earendil-works/*`、`@openai/codex`；当前 Pi 宿主包为 `@earendil-works/pi-coding-agent` 1.3.0，旧 `@mariozechner/pi-coding-agent` 停在 0.73.1，两者均被禁止），contracts 另不得依赖 storage。
- schema=1、api=2、receipt=2、handoff=1 分别管理；CLI/MCP 共用同一结果格式。

## 依据

- 构建规范 §2.2、§6、§8。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
