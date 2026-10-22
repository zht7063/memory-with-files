# 固定基线迁入记录

> 历史记录：本文件记录 0.3.0 之前的验证结果，其中引用的文件名与路径（如 `src/storage.ts`、`src/setup.ts`、`src/pi-adapter.ts`、`src/protocol.ts`、`src/lifecycle/migrate.ts`、receipt v2）为 0.3.0 前的布局，0.3.0 已删除或替换。当前结构见 [架构](../architecture.md)。

日期：2026-10-16。状态：**代码搬迁及原回归验证完成；尚未进行 0.2.0 改写。**

所有者明确要求“先把相关代码都迁移过来，然后再考虑如何改写本项目的代码和结构”。该指令调整原计划的顺序：M0 GUI 验收不再作为保真搬迁的前置条件。它不意味着宿主验收通过，也不意味着完整 M1/API v2 已实现。

## 来源与范围

来源为 `zht7063/skills@7b8be0e59647c90227c0cb945b279d7fa7ab14ef`，迁移 `packages/mwf/` 全部源文件和外部依赖脚本 `scripts/install-mwf.ts`，共 41 个文件。迁前逐个核对 [原始清单](M0-baseline-inventory.json) 的 SHA-256；逐文件目标路径和迁后校验值见 [迁入清单](baseline-import-manifest.json)。所有者授权见 [记录](M0-authorization.json)。

- Core、协议、存储、CLI、MCP、setup/detach 和旧 Pi adapter 均已迁入 `src/`，保持原来的扁平文件布局。
- 25 项原测试、辅助契约、legacy schema 1 fixture 均原样迁入 `tests/`。
- 模板、旧 skills 适配文件、构建／包／Pi 检查脚本、package、lockfile、TypeScript 配置均保留。
- 依赖安装由原 lockfile 完成，不复制上游 node_modules 或 dist；这两者仍为忽略的本地产物。
- 版本保留 `0.1.0`，Node 下限保留 `22.16.0`。没有宣称此基线已达到 0.2.0 目标。

## 仅有的路径调整

39 个迁入文件与固定上游逐字节相同。两处代码调整都只适配从 monorepo 子包到仓库根目录的移动：

| 文件 | 调整 |
| - | - |
| `scripts/check-package.ts` | 安装器位置从 `../../../scripts/install-mwf.ts` 改为 `./install-mwf.ts` |
| `scripts/install-mwf.ts` | packageRoot 从仓库内 `packages/mwf` 改为仓库根目录 |

原包 README 原样放在 [docs/upstream/MWF-0.1.0.md](../upstream/MWF-0.1.0.md)，避免大小写不敏感文件系统上覆盖本项目 `readme.md`。其中 monorepo 路径是历史原文；本仓库运行命令以根 README 为准。现有设计文档、职责说明与 M0 探针保留，当前状态已同步，不提前进行结构重组。原始上游未声明许可证，本次未擅自增加许可证。

## 本仓库验证

环境：macOS arm64，Node 26.8.2。所有修改项目接入的测试仅使用临时目录，没有给本项目或用户项目运行 setup。

| 命令／检查 | 结果 |
| - | - |
| `npm ci --no-audit --no-fund --cache /tmp/mwf-migration-npm-cache` | 99 个包安装成功；沙箱 DNS 失败后通过获准联网方式重试成功，lockfile 未变 |
| `npm test` | exit 0，build/typecheck 通过；25 pass、0 fail、0 skipped；[日志](baseline-import-tests.txt) |
| `npm run test:package` | exit 0，真实 tarball、空缓存离线安装、空 PATH、stdio 握手、读写/doctor、安装器预览/安装/重试/冲突保留；[日志](baseline-import-package.txt) |
| 安装器无 `--package` 的 `--dry-run` | 从当前独立仓库正确发现 packageRoot；中文空格项目及不存在的 prefix 均未被修改；[日志](baseline-import-installer.txt) |
| 来源对照 | 41 个文件全部覆盖；39 个完全相同，2 个仅上述路径调整 |
| `git diff --check` | 通过 |

## 未做与保留的旧行为

未重构、未升级依赖、未发布或推送，未运行会操作真实项目的安装命令。未重跑旧 `test:pi` 内部 loader 集成、真实桌面 GUI 或最低 Node/Linux 组合；不从旧单元回归推断这些宿主支持。

旧 init/setup 仍创建或更新 AGENTS 等项目规则，旧 MCP/adapter 也没有新版全部 enabled/generation/session 语义。这是有意保真的 0.1.0 基线，后续改写时再按 0.2.0 规范移除或调整；此次未把 M0 原型包装成生产保护逻辑。
