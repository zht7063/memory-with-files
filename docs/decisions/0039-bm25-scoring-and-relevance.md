# 0039 BM25 打分与 hook 相关性门槛

- 状态：已接受（2026-11-20）；细化 [0011](0011-search-in-memory-bigram.md)

## 决定

### 打分（`mwf-search` 常量，不暴露为配置）

- BM25，k1 = 1.2，b = 0.75。
- 字段加权（简化 BM25F：按权重重复计入词频）：title ×3，summary ×2，tags ×2，正文 ×1。
- `archived` 页默认不参与；`mwf search --status all` 时参与。

### hook 的"相关"判定

BM25 分数随语料规模漂移，不能用固定分数线。因此：

1. prompt 去停用词后，页面须命中至少 `recall_min_terms` 个**不同**的词才算相关；
2. 相关页按 BM25 分数排序，取前 `recall_top_k` 页；
3. 只剩一个词的短 prompt 不注入任何内容。

### 配置（`.mwf/config.toml`）

```toml
[hooks]
recall_min_terms = 2
recall_top_k = 3
stop_reminder = true
session_start_max_chars = 8000
```
