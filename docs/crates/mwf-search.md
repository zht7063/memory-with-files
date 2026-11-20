# mwf-search

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

**职责**：分词与 BM25，纯计算。**不依赖 `mwf-domain`**（[0041](../decisions/0041-search-is-a-leaf.md)），只接受自己的 `Doc` 结构，由 app 负责把页面转成 `Doc`——这样 search 成为一个零 workspace 依赖的叶子 crate。

## 公开 API（草案）

```rust
pub struct Doc<'a> { id: &'a str, title: &'a str, summary: &'a str, tags: &'a [String], body: &'a str }

pub fn tokenize(text: &str) -> Vec<String>;   // 拉丁按词小写；CJK 字二元组；去停用词（0011）

pub struct Index { … }
impl Index {
    pub fn build<'a>(docs: impl IntoIterator<Item = Doc<'a>>) -> Index;   // 字段加权 title×3 summary×2 tags×2 body×1
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit>;
    pub fn similar_to(&self, text: &str, exclude: &[&str], limit: usize) -> Vec<Hit>;  // 摄入辅助、possible_duplicate（0040）
}
pub struct Hit { id: String, score: f32, matched_terms: usize }   // matched_terms 用于 hook 门槛（0039）

pub const K1: f32 = 1.2;
pub const B: f32 = 0.75;
```

## 依赖

`unicode-segmentation`。开发依赖：`divan`（5000 页基准，0021）。

## 禁止

IO；依赖任何 workspace 内 crate。
