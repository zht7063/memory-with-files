# mwf-search

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

**职责**：分词与 BM25，纯计算。**不依赖 `mwf-domain`**（[0041](../decisions/0041-search-is-a-leaf.md)），只接受自己的 `Doc` 结构，由 app 负责把页面转成 `Doc`——这样 search 成为一个零 workspace 依赖的叶子 crate。

## 公开 API

```rust
#[derive(Clone, Copy)]
pub struct Doc<'a> { pub id: &'a str, pub title: &'a str, pub summary: &'a str, pub tags: &'a [String], pub body: &'a str }

pub fn tokenize(text: &str) -> Vec<String>;   // 规则见下文“分词”（0011）

pub struct Index { … }
impl Index {
    pub fn build<'a>(docs: impl IntoIterator<Item = Doc<'a>>) -> Index;   // 字段加权 title×3 summary×2 tags×2 body×1
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit>;
    pub fn similar_to(&self, text: &str, exclude: &[&str], limit: usize) -> Vec<Hit>;  // 摄入辅助、possible_duplicate（0040）
}
#[derive(Clone, PartialEq)]
pub struct Hit { pub id: String, pub score: f32, pub matched_terms: usize }   // matched_terms 用于 hook 门槛（0039）

pub const K1: f32 = 1.2;
pub const B: f32 = 0.75;
```

哪些页面参与（如 `archived` 页默认不参与，0039）由调用方决定：只把参与的页面转成 `Doc` 传给 `build`。

## 分词

- 非中日韩文字按 Unicode 词边界（UAX #29）切分并转小写：`Deploy mwf-search` → `deploy`、`mwf`、`search`。纯 ASCII 片段走等价的快速路径（单元测试与 `unicode_words` 逐一比对）。
- 中日韩文字（汉字、平假名、片假名、谚文的字母，含 `々`、`ー` 等迭代与长音符号；不含 `・`、`「」` 等标点）的连续片段切成重叠的字二元组：`部署失败` → `部署`、`署失`、`失败`。标点、空格、拉丁字母等任何其他字符都会截断片段；只有一个字的片段保留这个字本身，使单字查询也能命中。
- 去掉内置停用词：常见英文虚词（`the`、`and`、`of` …）与常见中文虚字、虚词（`的`、`了`、`我们`、`这个` …），列表在 `src/tokenize.rs`。

## 打分

- 简化 BM25F：词在字段中每出现一次按字段权重计入词频，文档长度同样按权重累计；`avgdl` 为全部文档加权长度的平均。
- `idf = ln(1 + (N − df + 0.5) / (df + 0.5))`（恒为正），分数 = Σ idf · tf · (K1 + 1) / (tf + K1 · (1 − B + B · dl / avgdl))，对查询中**不同**的词求和，查询里重复的词只算一次。
- `matched_terms` 是文档包含的不同查询词个数。只返回至少命中一个词的文档，按分数降序、id 升序，最多 `limit` 个。
- `similar_to` 把整段 `text` 当作查询，打分与 `search` 相同，并跳过 `exclude` 中的 id（如页面自身）。

## 性能

`benches/search.rs`（`cargo bench -p mwf-search`）用 5000 个合成页面（拉丁词与随机汉字各半）测“建索引 + 一次检索”，按正文大小分三档；查询是第 42 页的标题，计时前断言它返回满 `limit`（10）条结果。一次检索都会现建索引（0011），所以耗时随语料总量线性增长；在 4 vCPU 的 orb 上（2026-11），每页约 0.5 KB 时中位数 80 ms，约 1 KB 时 189 ms，约 1.8 KB 时 369 ms；已建好索引上的单次 `search` 为 23–87 µs（随页面大小）。100 ms 目标以每页约 0.5 KB 为参考，其余两档只作参考（[0047](../decisions/0047-search-benchmark-page-size.md)）。

## 依赖

`unicode-segmentation`。开发依赖：`divan`（5000 页基准，0021）。

## 禁止

IO；依赖任何 workspace 内 crate。
