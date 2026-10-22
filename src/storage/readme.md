# 文件存储

状态：已实现（从 0.1.0 基线迁入，T01 起按目录拆分）。只依赖 `contracts/`。

## 文件与导出

- `index.ts`：`canonicalRoot`、`safePath`（阻止路径／内部 symlink 越界）、`read`、`atomicWrite`、`walk`、`hash`、journal 恢复 `recover`、事务 `Transaction`（get/set/changes/commit）、基于 Node 内置 `node:sqlite` 的跨进程项目锁 `withProjectLock`；转导出 `MWFError`。
- `records.ts`：`records`/`validRecords`，读取 `.mwf/` 下的 schema 1 Markdown 记录（可含 archive）。
- `receipt.ts`（T01 自 integrations 下移）：本机接入 receipt `.mwf/local/integration.json` 的 zod schema（receipt_version 2、canonical_root、按 pi/codex 分的 client：enabled、binding_generation、runtime_path/version、node_path、owned_resources、cleanup_pending、probe）及读取函数 `receipt()`。

## 约束

- Markdown／交接 JSON 是权威数据；SQLite 只用于锁，不是第二套记忆库。
- 新交接、会话映射与本机状态都经 `Transaction` 提交，禁止 Adapter 裸写文件。
- 分层：contracts → **storage** → core；见 `tests/architecture.test.ts`。

## 依据

- 构建规范 §4.2、§6.2、§12；G01、S02、S09–S10。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
