# memory-with-files (MWF)

本地文件项目记忆：Markdown/schema 1 为长期数据，SQLite 辅助锁和 journal 保证写入、恢复与幂等。CLI、stdio MCP、Pi 原生扩展和 Codex hooks 共用 Core；Core 不调用模型或网络。

**当前版本 0.3.1**（npm 包 `@zht7063/mwf`，[GitHub Releases](https://github.com/zht7063/memory-with-files/releases)）。API 2、receipt 3（写入后不可降级到 0.2.x）、handoff 1；不再支持 0.1 安装；Node.js ≥ 22.19.0；MIT。旧 schema 1 数据可读，不承诺旧自动接入/API 1 兼容。正常操作不写 `AGENTS.md` 或 `CLAUDE.md`。

已实现会话/task 交接、revision/hash 冲突保护、中文检索、有界输出及分页、启用/停用/重绑定、保守旧版迁移、Pi 扩展与完整 runtime 的 Codex 插件。实际包已在隔离环境测试。**发布标准已变更**为 [linux-cli-harness/1](docs/release-criteria.md)：Linux 命令行中 Codex CLI 与 Pi harness 通过即可发布，不再以 44 项门槛、真实宿主、桌面、macOS 或性能报告为门槛；这些项目**仍未验证**，不能由 CLI 证据推导桌面支持。历史记录见 [实施验收记录](docs/validation/implementation-0.2.0.md)。

## 安装与使用（npm）

需要 Node.js ≥ 22.19.0。

```sh
# 全局安装
npm install -g @zht7063/mwf
mwf --help

# 或不安装，直接运行
npx @zht7063/mwf --help
```

```sh
mwf init --root /absolute/project --git-mode track
mwf status --root /absolute/project
mwf doctor --root /absolute/project
mwf recall --root /absolute/project --query '代理设置'
```

接入 Codex 或 Pi 需要已安装的插件／Pi 包，见下方 attach 用法与 [安装、启用、升级及卸载](docs/install.md)。Codex 插件 zip 与校验和在 [GitHub Releases](https://github.com/zht7063/memory-with-files/releases)。

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
node dist/cli.js doctor --root /absolute/project
node dist/cli.js recall --root /absolute/project --query '代理设置'
# 预览，再加 --apply 执行；runtime 必须是已安装的插件／Pi 包
node dist/cli.js attach --root /absolute/project --harness codex --plugin-root /absolute/installed-plugin
```

运行需要 Node ≥ 22.19.0（使用内置 `node:sqlite`；较旧 Node 会直接报 `No such built-in module: node:sqlite`）。命令列表见 `--help`；子命令没有单独帮助，`<cmd> --help` 打印同一份总帮助。

`init` 仅创建数据，首次必须选择 `track` 或 `ignore`。安装和启用分开；attach/rebind/detach 默认预览，`--apply` 才修改。`--harness` 取 `pi` 或 `codex`（detach 还可用 `all`），attach/rebind 必须传 `--harness`（否则 INVALID_INPUT，退出码 2），一次只接一个客户端。attach/rebind 先定位已安装 runtime：找不到或有多个时报 `PLUGIN_RUNTIME_REQUIRED`（用 `--plugin-root` 指定），版本不一致报 `RUNTIME_MISMATCH`；`--apply` 成功后做 direct 与 MCP 探测并把证据写入本机 receipt。`status`/`doctor` 分别报告数据健康和每个客户端的 installed / configured / probed 状态（installed 只与 receipt 比较；`--diagnostic-limit` 1–100，默认 5）。`setup` 已弃用，请用 init + attach。停用保留数据，独立 CLI 仍可读取。自动接入验证真实 cwd、最近项目、enabled、root、runtime 和 generation。

- [安装、启用、升级及卸载](docs/install.md)
- [0.1 → 0.2 迁移（历史，需 0.2.x）](docs/migration-0.2.0.md)
- [API 2 协议](docs/protocol.md)
- [0.2.0 构建计划与全部验收编号（历史）](docs/build-plan-0.2.0.md)
- [兼容矩阵](docs/compatibility.md) · [文档索引](docs/readme.md) · [变更记录](CHANGELOG.md)

源码分层为 `contracts/` → `storage/`、`retrieval/`、`context/` → `core/` → `lifecycle/`、`integrations/` 与入口 `src/cli.ts`、`src/mcp.ts`（`src/interfaces/` 目前为空）；`tests/architecture.test.ts` 禁止 `core/`、`contracts/` 依赖 lifecycle、integrations 或宿主 SDK。各目录 readme.md 说明实际文件。已合并 T01（Core 解耦）、T02（runtime 定位与 attach 探测、RUNTIME_MISMATCH）、T03（status/doctor 真实诊断）、T04（上下文状态机）、T05（会话身份与 worktree 隔离）、T06（binding 迁移）、T07/T08（Pi/Codex 验收）、T09（单宿主生命周期）、T10（端到端测试）。`src/core.ts` 是薄导出，`dist/cli.js` 和 npm 根导入保持可用。单一 npm 包和 lockfile；`pack:release` 从同一 tarball 组装 Codex zip 与 SHA256SUMS，不发布。

0.1.0 来源为 `zht7063/skills@7b8be0e59647c90227c0cb945b279d7fa7ab14ef` 的 `packages/mwf`，见[迁入记录](docs/validation/baseline-import.md)。历史文档及 M0 探针仅作来源和实验记录。

## 卸载

先 `detach --harness all --apply`（确认 `disabled_clean`），再 `pi remove <package dir>` / Codex 插件卸载（`codex plugin remove mwf@<marketplace>`）。`.mwf/` 记忆数据可保留。完整文件清单与命令见 [packaging/UNINSTALL.md](packaging/UNINSTALL.md)。
