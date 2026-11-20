# 设计树：未决问题

讨论按轮进行。每轮只问"前置决策都已确定"的问题；确定后写成 ADR 并从这里移除。

- 第 1 轮 → ADR 0001–0007
- 第 2 轮 → ADR 0008–0015

## 第 3 轮（进行中）

| # | 问题 | 推荐 | 依赖 |
| --- | --- | --- | --- |
| R3-1 | 谁来写页面文件 | agent 直接用自己的编辑工具改 `.mwf/` 下的 Markdown；mwf 提供脚手架、lint、目录重建，不要求写入必须经过 CLI | 0008 |
| R3-2 | 页面 frontmatter 与类型 | `title`、`type`（preference/decision/incident/knowledge/task 五选一）、`tags`、`status`（active/archived）、`created`/`updated`；`paths` 作用域取消 | 0008 |
| R3-3 | 目录布局与 slug | `.mwf/pages/<slug>.md` 扁平存放；slug = 文件名 = 链接目标，全局唯一，`[a-z0-9-]` | 0008 |
| R3-4 | handoff 是否独立 | 取消独立概念：交接写成 `type: task` 页面，由 skill 约定结构 | 0008 |
| R3-5 | inbox / propose 是否保留 | 取消，审查靠 git diff | 0008 |
| R3-6 | `log.md` | mwf 自己的写操作在 `.mwf/log.md` 追加一行；agent 直接编辑不记 | 0008 |
| R3-7 | `.mwf/` 是否进 git、项目根如何定位 | 默认提交进 git（`init --local` 则忽略）；命令从 cwd 向上找 `.mwf/`；`init` 在 git 根目录执行 | 0002 |
| R3-8 | 支持哪些宿主 | 首版 Claude Code + Codex；Pi 延后 | 0009 |
| R3-9 | 测试策略 | crate 内单元测试；bin 端到端测试（assert_cmd + tempdir）；输出快照（insta） | 0015 |
| R3-10 | release 工具 | 用 `dist`（原 cargo-dist）生成 Release 与 Homebrew formula | 0004, 0012 |

## 后续轮次（等待前置决策）

- **命令面**：CLI 命令列表、输出格式（人读 / `--json`）、退出码 ← R3-1, R3-2
- **lint 规则**：断链、孤立页、frontmatter、secret 扫描、重复标题 ← R3-1, R3-2
- **安全特性**：删除/归档流程、是否需要确认 ← R3-1
- **hooks 行为**：SessionStart / UserPromptSubmit / Stop 各注入或做什么、相关性阈值、是否还需要 supervisor 子进程 ← R3-1, R3-8
- **lifecycle 细节**：写入哪些宿主文件、skills 怎么安装、卸载如何还原 ← R3-8
- **`index.md` 的格式**与生成时机 ← R3-1, R3-2, R3-3
- **v2 成为默认分支的时机** ← 实施计划
- **每个 crate 的公开 API** → `docs/crates/*.md` ← 以上全部
