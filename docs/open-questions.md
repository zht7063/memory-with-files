# 设计树：讨论记录

设计讨论按轮进行，每轮只问"前置决策都已确定"的问题；确定后写成 ADR。未回复的问题视为接受推荐答案。

| 轮次 | 主题 | 结果 |
| --- | --- | --- |
| 1 | 重写范围、兼容、分发、分层机制、同步、文档 | ADR 0001–0007 |
| 2 | LLM wiki 分工、不做 MCP、孤儿分支、检索、工具链、并发、拓扑 | ADR 0008–0015 |
| 3 | 写入经过 mwf、页面模型、日志、git、宿主、测试、发布 | ADR 0016–0022 |
| 4 | 命令集合、冲突检测、绕过守卫、secret、删除、目录、输出、hooks、安装 | ADR 0023–0031、[cli.md](cli.md) |
| 5 | frontmatter、一致性与上限、会话状态、lint、skill、lifecycle 安全 | ADR 0032–0037 |
| 6 | Markdown 链接、BM25 打分与 hook 门槛 | ADR 0038–0039 |
| 7 | LLM wiki 工作流 | ADR 0040 |
| 8 | search 叶子化、依赖策略、错误与时钟、实施与分支 | ADR 0041–0044、[crates/](crates/)、[implementation-plan.md](implementation-plan.md) |
| 9 | 默认分支切换、开工前文档补正 | ADR 0045–0046 |
| P2 | `init` 布局、忽略规则、已有 `.mwf/`、log 追加、trash 重名、配置未知键 | ADR 0048 |
| P2 | app 错误码、100 KB 上限、`index` 不带 `--rebuild`、相关页与重复页门槛、lint 细节 | ADR 0049 |
| P2 | CLI 文本格式、`--json` 信封、用法错误、stdin 上限、`clap` 版本 | ADR 0050 |
| P3 | hook 事件名与入口、SessionStart 内容与截断、注入的密钥隐去、Stop 提醒、预算与失败输出、会话状态格式、项目根与守卫路径 | ADR 0051 |

## 当前未决问题

无。设计树已收敛（2026-11-20），可以从 [implementation-plan.md](implementation-plan.md) 的 P0 开始实施。

实施中出现的新问题：先在此处登记，确定后写 ADR。
