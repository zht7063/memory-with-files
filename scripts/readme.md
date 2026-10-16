# 构建与验收脚本

状态：已迁入 0.1.0 的 build、check-package、check-pi、pi-contract 及独立安装器。当前可运行 `npm ci`、`npm test`（包含 build/typecheck）、`npm run build`、`npm run test:package`。`test:pi` 是旧内部 loader 检查，需额外项目和 Pi 路径参数，不代表新版原生宿主验收。下面表格保留 0.2.0 目标职责；`test:integrations` 和 `pack:release` 尚未实现。

| 目标命令 | 阶段 | 必须执行的工作 |
| - | - | - |
| `npm ci` | M1 | 按唯一 package-lock 安装，Node ≥22.19.0 |
| `npm run typecheck` | M1 | 检查实际业务源码与入口类型 |
| `npm test` | M1 起 | 执行确定性回归，包含迁入存储测试；不能用零测试证明完成 |
| `npm run build` | M1 起 | 生成 dist、复制实际资源，产物不依赖 TS loader |
| `npm run test:package` | M1 起、M6 完整验收 | 安装真实 tarball 到隔离目录，离开 checkout 验证 Core/CLI/MCP、Pi 入口及资源 |
| `npm run test:integrations` | M0 实验、M4/M5 完整实现 | 分列无需模型的契约测试与真实宿主结果；缺少宿主标 not_run |
| `npm run pack:release` | M5/M6 | 单版本组装 npm/Codex 产物、校验文件清单并生成 SHA256SUMS；不自动 publish |

## 包验收要求

- 沿用固定基线的包检查经验；先迁移再补充，不另起复杂构建系统。
- npm bin 目标是 `dist/cli.js`；Pi 扩展也指向编译产物。
- Codex runtime 从本次 npm 产物构建，不手工同步第二份源码。
- 完整携带或经验证内联运行依赖，锁定离线 tokenizer 词表；不依赖全局 MWF、原 skills checkout 或开发机 node_modules。
- 在隔离 HOME/PATH、无开发依赖和无网络情况下验证实际安装包；含空格／中文路径通过 argv 传递。
- 分清运行环境需要 Node 与包中携带 JS，分别验证终端和 GUI 下的 Node 路径。
- release 检查不得将真实宿主 not_run 当 pass；构建归档不等于取得发布资格。
- 产物写入已忽略的 `dist/` 与 `releases/`，不提交生成文件。

实现顺序及门槛见 [构建计划](../docs/build-plan-0.2.0.md) §4、§5。远程发布需要另行授权。
