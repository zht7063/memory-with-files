# 0003 撤掉 SQLite，检索改为 BM25 + LLM wiki

- 状态：已接受（方向）；具体形态见 open-questions（2026-11-20）

## 背景

1.x 用 SQLite FTS5（trigram）作为派生索引 `index.db`，带来实验性依赖、索引失效/刷新逻辑和锁内同步的复杂度。

## 决定

- 不再使用 SQLite 或任何数据库。Markdown 文件是唯一事实来源。
- 关键词检索用 BM25。
- 组织与导航采用 "LLM wiki" 方式（具体含义、mwf 与宿主 LLM 的分工待定）。

## 细化

- "LLM wiki" 的含义与分工：[0008](0008-llm-wiki-division.md)
- 索引不落盘、分词方式：[0011](0011-search-in-memory-bigram.md)
