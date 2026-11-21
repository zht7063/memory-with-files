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

## 当前未决问题

无。设计树已收敛（2026-11-20），可以从 [implementation-plan.md](implementation-plan.md) 的 P0 开始实施。

实施中出现的新问题：先在此处登记，确定后写 ADR。
