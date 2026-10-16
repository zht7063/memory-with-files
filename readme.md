# memory-with-files (MWF)

本地文件项目记忆：Markdown/schema 1 为长期数据，SQLite 辅助锁和 journal 保证写入、恢复与幂等。CLI、stdio MCP、Pi 原生扩展和 Codex hooks 共用 Core；Core 不调用模型或网络。

**0.2.0 开发产物，尚未发布。** API 2、receipt 2、handoff 1；Node.js ≥ 22.19.0；MIT。旧 schema 1 数据可读，不承诺旧自动接入/API 1 兼容。正常操作不写 `AGENTS.md` 或 `CLAUDE.md`。

已实现会话/task 交接、revision/hash 冲突保护、中文检索、有界输出及分页、启用/停用/重绑定、保守旧版迁移、Pi 扩展与完整 runtime 的 Codex 插件。实际包已在隔离环境测试；**完整 44 项门槛、Codex 桌面 GUI、Linux 和完整性能报告尚未全部关闭**。详见 [实施验收记录](docs/validation/implementation-0.2.0.md)，不能由 CLI 证据推导桌面支持。

## 开发与本地使用

```sh
npm ci
npm test
npm run test:package
npm run pack:release
npm run test:integrations
node dist/cli.js --help
```

```sh
node dist/cli.js init --root /absolute/project --git-mode track
node dist/cli.js status --root /absolute/project
node dist/cli.js recall --root /absolute/project --query '代理设置'
```

`init` 仅创建数据，首次必须选择 `track` 或 `ignore`。安装和启用分开；attach/rebind/detach 默认预览，`--apply` 才修改。停用保留数据，独立 CLI 仍可读取。自动接入验证真实 cwd、最近项目、enabled、root、runtime 和 generation。

- [安装、启用、升级及卸载](docs/install.md)
- [0.1 → 0.2 迁移](docs/migration-0.2.0.md)
- [API 2 协议](docs/protocol.md)
- [构建计划与全部验收编号](docs/build-plan-0.2.0.md)
- [兼容矩阵](docs/compatibility.md) · [文档索引](docs/readme.md) · [变更记录](CHANGELOG.md)

源码分为 `contracts/`、`core/`、`storage/`、`context/`、`lifecycle/` 和 `integrations/`。`src/core.ts` 等旧路径是薄导出，`dist/cli.js` 和 npm 根导入保持可用。单一 npm 包和 lockfile；`pack:release` 从同一 tarball 组装 Codex zip 与 SHA256SUMS，不发布。

0.1.0 来源为 `zht7063/skills@7b8be0e59647c90227c0cb945b279d7fa7ab14ef` 的 `packages/mwf`，见[迁入记录](docs/validation/baseline-import.md)。历史文档及 M0 探针仅作来源和实验记录。
