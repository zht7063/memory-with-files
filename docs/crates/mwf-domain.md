# mwf-domain

> 状态：草案（第 8 轮评审）

**职责**：页面的领域模型与一切纯计算规则。不做 IO、不读时钟、不读环境变量。

## 公开 API（草案）

```rust
pub struct Slug(String);              // [a-z0-9-]，Slug::parse(&str) -> Result<Slug, DomainError>
pub enum PageType { Preference, Decision, Knowledge, Incident, Task }   // 顺序即 index 分组顺序
pub enum Status { Active, Archived }
pub struct Timestamp(String);         // RFC3339 UTC，由调用方传入
pub struct Frontmatter { title, page_type, summary, tags: Vec<String>, status, created, updated }
pub struct Page { slug: Slug, fm: Frontmatter, body: String }
pub struct Rev(String);               // 文件内容 sha256 的前 12 个十六进制字符；Rev::of(&[u8])

// frontmatter（0032）
pub fn parse_page(slug: Slug, text: &str) -> Result<Page, DomainError>;
pub fn render_page(page: &Page) -> String;

// 链接（0038）
pub struct Link { target: Slug, anchor: Option<String>, span: Range<usize> }
pub fn internal_links(body: &str) -> Vec<Link>;            // 跳过代码块与行内代码
pub fn rewrite_links(body: &str, from: &Slug, to: &Slug) -> String;
pub fn unlink(body: &str, target: &Slug) -> String;        // delete --unlink：链接改纯文本

// secret 扫描（0025）
pub struct SecretFinding { rule: &'static str, line: usize, redacted: String }
pub fn scan_added(before: &str, after: &str) -> Vec<SecretFinding>;
pub fn scan_all(text: &str) -> Vec<SecretFinding>;

// patch（0023）
pub fn apply_patch(body: &str, old: &str, new: &str) -> Result<String, DomainError>;  // NoMatch / Ambiguous

// 生成物（0027, 0029）
pub fn render_index(pages: &[&Page]) -> String;
pub fn render_log_line(ts: &Timestamp, op: &LogOp, slug: &Slug, title: &str) -> String;

// lint 中的纯规则（0035）；需要语料的 possible_duplicate 由 app 组合 search 完成
pub fn validate(page: &Page, file_stem: &str) -> Vec<Issue>;
```

## 依赖

`regex`（secret 规则）、`sha2`（Rev）、`thiserror`。

## 禁止

文件系统、时钟、环境变量、进程；依赖任何 workspace 内 crate。
