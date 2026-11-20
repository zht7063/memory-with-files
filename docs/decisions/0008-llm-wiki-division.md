# 0008 LLM wiki：mwf 是给 agent 用的 wiki 引擎，不调用 LLM

- 状态：已接受（2026-11-20）；细化 [0003](0003-drop-sqlite-bm25-llm-wiki.md)

## 决定

记忆是一组互相 `[[链接]]` 的 Markdown 页面，有一个总目录页。检索时 agent 先读目录、顺链接阅读，再用 BM25 关键词搜索补漏。

**mwf 本身不调用任何 LLM API。** 编写、整理、合并页面都由宿主 agent（Claude Code / Codex 等）完成。mwf 只提供：

- 页面存储
- `[[链接]]` 解析与反向链接计算
- 自动生成目录 `index.md`
- BM25 搜索
- lint：断链、孤立页、frontmatter 不合法

## 后果

- mwf 没有网络依赖、没有 API key，行为完全确定，可测试。
- "记忆质量"由 skill 文本（教 agent 如何维护 wiki）决定，`mwf-assets` 的内容是产品的一部分。
