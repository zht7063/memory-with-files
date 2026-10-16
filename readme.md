# memory-with-files (MWF)

以本地文件保存项目记忆，供 coding agent 按需读取、检索和更新。

本项目将 [zht7063/skills](https://github.com/zht7063/skills) 中的 `memory-with-files` 独立出来，保留现有存储核心与 Markdown 记录格式，并面向 **Pi agent** 与 **Codex CLI** 开展原生接入适配。

## 当前状态与版本

- 原仓库中的实现视为 **0.1.0**；独立项目从 **0.2.0** 开始。
- 固定上游的 MWF **0.1.0 代码已迁入仓库根目录**，包括 Core、CLI/MCP、旧 Pi 适配器、安装器、测试和模板。**0.2.0 尚未实现或发布**；先保留旧行为，再讨论改写与结构调整。
- 迁移基线：原仓库提交 `7b8be0e59647c90227c0cb945b279d7fa7ab14ef` 中的 `packages/mwf`。
- 计划保留 npm 包名 `@zht7063/mwf`，目标运行环境为 Node.js ≥ 22.19.0。

## 0.2.0 目标

- 脱离原 skills 仓库，支持独立安装、升级、停用和卸载。
- CLI、MCP 与宿主适配器共用无模型、无网络请求的 Core。
- 兼容已有 schema 1 记忆；按会话隔离交接，跨会话任务显式选择 task ID。
- 摘要优先、正文按需读取，对模型上下文设置预算并去重。
- 安装与项目启用分离；只有显式启用的项目才自动加载记忆。
- 正常工作流不创建或修改 `AGENTS.md`、`CLAUDE.md` 等项目规则文件。
- 停用接入与卸载程序分开处理，默认保留记忆与交接数据。

以上均为目标行为，不代表当前已支持。Pi 以 v1.1.0 为首个兼容验证基线；构建规范先验证 Codex 桌面插件路径，**Codex CLI 必须单独通过真实 hooks、插件发现和 MCP 测试后，才能标记为支持**。

## 仓库结构

```text
.
├── readme.md
├── .gitignore
├── src/
│   ├── contracts/           # 共用契约、错误与版本
│   ├── core/                # 记录、交接与读取用例
│   ├── storage/             # 路径、锁、事务与恢复
│   ├── retrieval/           # 资格过滤、匹配与排序
│   ├── context/             # 计量、预算、分页与渲染
│   ├── interfaces/          # CLI 与 stdio MCP
│   ├── integrations/
│   │   ├── shared/          # root、会话、去重与诊断
│   │   ├── pi/              # Pi 原生扩展
│   │   └── codex/           # Codex hooks
│   └── lifecycle/           # 初始化、接入、停用与迁移
├── assets/
│   ├── memory/              # 数据模板与 protocol
│   └── skills/              # 包内 setup 与使用说明
├── packaging/codex/        # Codex 插件打包
├── scripts/                # 构建、包验收与发布检查
├── tests/                  # 回归、契约与宿主测试
└── docs/                   # 规范、计划、架构与兼容矩阵
```

上图是 0.2.0 目标布局。当前迁入的实现仍保留上游扁平文件布局：`src/*.ts`、`tests/*.test.ts`、`assets/mwf-template/`、`adapters/` 和 `scripts/`。规划子目录暂保留职责说明；M0 探针位于 `tests/integrations/m0/`。只有一个源码包和 lockfile。

## 文档与开发入口

- [文档索引](docs/readme.md)
- [MWF 0.2.0 构建文档](docs/MWF%200.2.0%20构建文档.md)：目标规范与发布验收门槛，保留原文。
- [0.2.0 构建计划书](docs/build-plan-0.2.0.md)：后续开发执行入口，包含 M0–M6 工作包、前置条件、交付物和全部 44 项验收编号追踪。
- [架构与目录约束](docs/architecture.md)：依赖方向、数据职责、关键调用路径与预算。
- [兼容矩阵与 M0 清单](docs/compatibility.md)：目标宿主、待验证实验和证据要求；已有部分运行时实验，未验证组合单列。
- [测试约定](tests/readme.md)与[脚本约定](scripts/readme.md)：未来测试和构建命令的职责；M0 探针可独立运行。

后续需要保留的设计、调研、实施与验证文档统一放入 `docs/`，并更新文档索引。构建文档中的命令和接口是待实现规范，不是当前可用功能。

2026-10-16 按所有者要求先迁入全部相关代码，GUI 验收不再阻塞代码搬迁。来源、必要路径调整和验证结果见 [迁入记录](docs/validation/baseline-import.md)。此前 [M0 报告](docs/validation/M0-validation.md)保留为宿主实验记录，不表示新版适配已验收。

## 当前可运行命令

```bash
npm ci
npm test
npm run test:package
node dist/cli.js --help
```

`npm test` 包含构建和类型检查。包版本仍为 0.1.0，Node 下限沿用上游 22.16.0；22.19.0 是后续 0.2.0 目标。旧版 init/setup 仍会创建或更新项目规则文件；新版本“正常流程不改规则文件”的行为尚未实现。旧版用法参见 [归档 README](docs/upstream/MWF-0.1.0.md)，其中 `packages/mwf` 路径在本仓库对应根目录。
