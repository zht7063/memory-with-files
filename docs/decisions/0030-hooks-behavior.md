# 0030 hooks 行为

- 状态：已接受（2026-11-20）

## 决定

所有 hook：没有 `.mwf/` 的项目里什么都不做；任何失败都不打断宿主（退出 0）；注入内容用每次随机的 fence 包裹并清理控制字符（沿用 1.x 的做法）。

| 事件 | 行为 |
| --- | --- |
| SessionStart | 注入 `index.md` + 全部 active `preference` 页正文 + 最近 10 条 `log.md`；总长截断到 8000 字符并说明截断 |
| UserPromptSubmit | 以 prompt 做 BM25 搜索，取超过相关性阈值的前 3 页，注入 slug、标题、summary（不注入正文）；同一会话同一页只注入一次 |
| Stop | 每轮提醒一次"有值得记的就保存"；配置可关闭 |
| PreToolUse | 见 [0024](0024-bypass-guard.md) |

- 不再使用 supervisor 子进程：单进程内部计时，超过预算即放弃可选工作并输出已有结果。
- 会话状态的存放位置、相关性阈值的定义与配置项见 open-questions。
