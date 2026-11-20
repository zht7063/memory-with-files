# 设计树：未决问题

讨论按轮进行。每轮只问"前置决策都已确定"的问题；确定后写成 ADR 并从这里移除。

- 第 1 轮 → ADR 0001–0007
- 第 2 轮 → ADR 0008–0015
- 第 3 轮 → ADR 0016–0022

## 第 4 轮（进行中）

| # | 问题 | 推荐 | 依赖 |
| --- | --- | --- | --- |
| R4-1 | 写命令集合 | `new` / `write`（整页替换）/ `patch`（精确字符串替换）/ `archive` / `unarchive` / `rename`（同步改入链）/ `delete` | 0016 |
| R4-2 | 写冲突检测 | 读命令返回页面 `rev`（内容哈希）；`write` 必须带 `--rev`，不一致则拒绝；`patch` 以"旧字符串唯一匹配"作为检查 | 0016 |
| R4-3 | 防止绕过 mwf | Claude Code 安装 PreToolUse hook 拒绝对 `.mwf/` 的直接编辑；Codex 若支持同类 hook 同样处理；skill 明确要求走 CLI | 0016, 0020 |
| R4-4 | secret 扫描 | 写入前扫描，命中即拒绝，无绕过开关；规则参考 1.x | 0016 |
| R4-5 | 删除语义 | `delete` 把页面移入 `.mwf/trash/`（不进 git），有入链时拒绝（除非 `--unlink`）；无 TTY 两步确认 | 0016, 0019 |
| R4-6 | 增加 `summary` 字段 | frontmatter 增加必填的一行 `summary`，供 `index.md`、搜索结果、hook 注入使用 | 0017 |
| R4-7 | `index.md` 格式 | 按 type 分组，每行 `- [[slug]] 标题 — summary`；archived 不列；每次写入后在锁内重建 | 0016, 0017 |
| R4-8 | 读命令集合 | `show`（含反向链接与 rev）/ `search` / `list`（按 type、tag、status 过滤）/ `lint` / `log` | 0016, 0017 |
| R4-9 | CLI 输出与退出码 | 默认输出给 agent 读的简洁文本；`--json` 输出结构化结果；退出码 0 成功 / 1 操作失败 / 2 用法错误 | 0009 |
| R4-10 | `log.md` 格式与合并 | 每行 `<RFC3339 UTC> <op> <slug> <title>`；`init` 写 `.gitattributes`：`.mwf/log.md merge=union` | 0018, 0019 |
| R4-11 | hooks 行为 | SessionStart：注入 `index.md` + 全部 active preference + 最近 10 条日志；UserPromptSubmit：BM25 搜 prompt，超阈值的前 3 页摘要注入，同一会话同一页只注入一次；Stop：每轮提醒一次保存；单进程内部计时，不再用 supervisor | 0011, 0016, 0017 |
| R4-12 | 安装范围 | 与 1.x 一致，装到用户级（`~/.claude`、`~/.codex`）；没有 `.mwf/` 的项目里 hook 什么都不做 | 0020 |

## 待查事实

- Codex 的 hooks 是否支持类似 PreToolUse 的"工具调用前拦截"，能否识别 apply_patch 的目标路径（影响 R4-3）。

## 后续轮次（等待前置决策）

- **会话状态文件**（"每页只注入一次"的记录放哪、何时清理） ← R4-11
- **config.toml 的配置项**（相关性阈值、Stop 开关等） ← R4-11
- **lint 规则清单与严重级别** ← R4-4, R4-6, R4-8
- **skill 文本的内容与组织**（教 agent 维护 wiki） ← R4-1, R4-8
- **lifecycle 细节**：写哪些文件、备份与卸载还原 ← R4-3, R4-12
- **v2 成为默认分支的时机、实施阶段划分** → `implementation-plan.md` ← 以上全部
- **每个 crate 的公开 API** → `docs/crates/*.md` ← 以上全部
