# Core 用例

状态：已实现。确定性实现，不导入宿主 SDK、不调用模型或网络。

## 文件与导出

- `index.ts`：操作输入 `schemas`（`Operation` 类型）、统一 `Result`、`execute`/`operate`、`initialize`（init）、`config`、`inbox`、`rebuild`、`duplicates`、`diagnose`、`operateWithHooks`、`legacyInstall`、`isMutation`。操作包括 bootstrap、recall、get、add、propose、update、forget、compact、rebuild-index、handoff、status、doctor、init、migrate 等。
- `handoff.ts`：按 scope 的交接 `readHandoff`/`saveHandoff`/`listHandoffs`，revision/hash 冲突保护。
- `identity.ts`（T05）：`sessionIdentity`（session*key = hash(client, host_session_id, branch)，session_ref = `s*` + hash(root, key)）、`registerSession`、`resolveSession`。映射写在 `.mwf/local/contexts/<session_ref>.json`；损坏、伪造或属于其他 root（含其他 git worktree）的映射以 `CONTEXT_REQUIRED` 拒绝，注册不会覆盖损坏映射。
- `diagnostics.ts`（T03）：`integrationDiagnostics`，status/doctor 的真实接入诊断，按客户端输出 `installed`（runtime 是否存在、版本是否一致）、`configured`（enabled、generation、issues：ROOT_MISMATCH、INVALID_BINDING、RUNTIME_MISMATCH、CLEANUP_PENDING、OWNERSHIP_MISSING、OWNERSHIP_CONFLICT:<path>）、`probed`（attach 写入的 probe 证据；过期或缺失报告 unknown/not_run）。数据健康与接入健康分开。installed 只与 receipt 记录的版本比较。status/doctor 的 `diagnostic_limit`（CLI `--diagnostic-limit`）为 1–100，默认 5。

## 分层

分层（`tests/architecture.test.ts` 强制）：contracts → storage / retrieval / context → core → lifecycle / integrations / 接口入口（`src/cli.ts`、`src/mcp.ts`）。测试只检查 `src/core/` 与 `src/contracts/` 的传递依赖：不得导入 `integrations/`、`lifecycle/` 或宿主 SDK（`@modelcontextprotocol/*`、`@mariozechner/*`、`@earendil-works/*`、`@openai/codex`；当前 Pi 宿主包为 `@earendil-works/pi-coding-agent` 1.3.0，旧 `@mariozechner/pi-coding-agent` 停在 0.73.1，两者均被禁止），contracts 另不得依赖 storage。有两处有意的跨层导入：`context/output.ts` 仅 `import type { Result }` 自 core，无运行时依赖；根目录 `src/core.ts` 是薄组合入口，把 integrations registry 的 `hostIssues` 注入 Core 的 `execute`/`operate`（0.3 起无 0.1 迁移），它不属于 `src/core/`，因此不受该测试约束。

## 依据

- 构建规范 §4、§6–8、§14；G01–G02、S01–S05、S10–S11。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
