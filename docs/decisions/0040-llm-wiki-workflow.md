# 0040 LLM wiki 工作流：mwf 发现候选，agent 判断与动手

- 状态：已接受（2026-11-20）；细化 [0008](0008-llm-wiki-division.md)

## 背景

LLM wiki 模式 = 三层（原始资料 / wiki 页面 / 约定）+ 三种操作（摄入 / 查询 / 体检）。mwf 不调用 LLM，语义判断只能由 agent 完成；mwf 的职责是用 BM25 与链接图**发现候选**，并通过 skill 与 hook 提示**在合适时机触发流程**。

## 决定

| 方面 | 决定 |
| --- | --- |
| 原始资料层 | 2.0 不设 `sources/`。资料就是会话、代码、提交；页面用外部链接引用代码路径或写提交哈希 |
| 约定层 | 不设单独约定文件。项目约定写成 `preference` 页面（SessionStart 总会注入）；通用维护方法在 `mwf` skill 中 |
| 页面类型 | 保持 5 种；`knowledge` 页兼作主题汇总页（hub），skill 鼓励"一个主题一页、持续累积" |
| 摄入辅助 | 每个写命令成功后，用本次写入内容做 BM25，附带"可能相关但尚未链接"的前 3 页（slug、标题、summary） |
| 查询辅助 | `show` 列出出链与反向链接时附带对方标题与 summary |
| 体检辅助 | lint 增加 warning `possible_duplicate`（页面两两 BM25 相似度过高）；SessionStart 在有 lint 问题时附一行计数；skill 定义体检流程：合并重复、修正矛盾、归档过时、补链接 |
| 目录注入 | `index.md` 始终完整；SessionStart 在预算内先注入 preference 正文，再按类型顺序注入目录行，超出则截断并提示 `mwf index` / `mwf list --type …` |
| Stop 提醒 | 按摄入流程：先 `mwf search`；优先 `patch` 现有页，否则 `new` 并写好 summary；按"相关未链接"补双向链接；没有值得记的就什么都不做 |

## 后果

- `mwf-search` 需要"以文档查文档"的相似度接口（摄入辅助与 `possible_duplicate` 共用）。
- skill 文本承担主要的流程教学，是产品质量的关键部分，需要和代码一样评审。
