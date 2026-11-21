# mwf-domain

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

**职责**：页面的领域模型与一切纯计算规则。不做 IO、不读时钟、不读环境变量。

## 公开 API

P1 已实现（`crates/mwf-domain`）；与最初草案的差异见下方“实现说明”。

```rust
pub struct Slug(String);              // [a-z0-9-]，非空；Slug::parse(&str) -> Result<Slug, DomainError>
pub enum PageType { Preference, Decision, Knowledge, Incident, Task }   // 声明顺序 = index 分组顺序；PageType::ALL
pub enum Status { Active, Archived }
pub struct Timestamp(String);         // YYYY-MM-DDTHH:MM:SSZ，派生 Ord 即时间顺序
impl Timestamp {
    pub fn parse(&str) -> Result<Timestamp, DomainError>;            // 校验真实日期
    pub fn from_unix_secs(u64) -> Result<Timestamp, DomainError>;    // 0046；超过 9999-12-31 报 TimestampOutOfRange
}
pub struct Frontmatter { title, page_type, summary, tags: Vec<String>, status, created, updated }  // 字段 pub
impl Frontmatter { pub fn check(&self) -> Result<(), DomainError>; }  // 写入前校验；SUMMARY_MAX_CHARS = 120
pub struct Page { slug: Slug, fm: Frontmatter, body: String }
pub struct Rev(String);               // 文件内容 sha256 的前 12 个十六进制字符；Rev::of(&[u8])

pub enum DomainError { InvalidSlug, InvalidField { field, reason }, Frontmatter { line, reason },
                       InvalidTimestamp, TimestampOutOfRange, PatchNoMatch, PatchAmbiguous { matches } }

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
pub enum LogOp { New, Write, Patch, Set, Archive, Unarchive, Rename { from: Slug }, Delete }
pub fn render_index(pages: &[&Page]) -> String;
pub fn render_log_line(ts: &Timestamp, op: &LogOp, slug: &Slug, title: &str) -> String;  // 不含换行

// lint 中只需单个页面文件的规则（0035）
pub enum Severity { Warning, Error }
pub struct Issue { rule: &'static str, severity: Severity, message: String }
pub fn validate(file_stem: &str, text: &str, now: &Timestamp) -> Vec<Issue>;   // STALE_TASK_DAYS = 30
```

## 实现说明

- **frontmatter**：`tags` 可省略（空列表），`status` 可省略（`active`），其余字段必填；未知字段、重复字段、子集外的 YAML 语法（单引号、`|`、锚点、`a: b` 这类未加引号的值……）一律报错并给出行号。双引号字符串只支持 `\"` 与 `\\` 转义。`render_page` 只在 YAML 会原样读回时输出裸值（`true`、`42`、`a: b` 等都会加引号），保证 `parse_page(render_page(p)) == p`。正文为结束 `---` 行之后的原始字节。
- **title / summary / tag**：非空、单行、无控制字符、首尾无空白；summary 按字符计 ≤ 120。
- **链接**：`[文字](dest)`、`[文字](dest "title")`、`<dest>`；路径按 `.mwf/pages/` 解析，`./a.md`、`../pages/a.md`、`../../.mwf/pages/a.md` 都是内部链接，`sub/a.md`、`../a.md`、绝对路径、带 scheme、带 `?` 的都不是。跳过围栏代码块（`` ` `` / `~`，未闭合则到文末）、行内代码、图片 `![..](..)` 与转义的 `\[`；不识别缩进代码块。链接文字与目标须在同一行。`rewrite_links` 保留文字、锚点、title 与路径前缀。
- **patch**：匹配数按每个起始位置计（重叠也算，`aaa` 中的 `aa` 是 2 处）；空的 `old` 是 `InvalidField`。
- **secret**：规则与 1.x `src/core/secrets.ts` 相同（19 条）。`regex` 不支持前瞻，`aws-secret-access-key` 改为“取整段再要求恰好 40 个字符”。`scan_added` 以（规则, 命中原文）判断是否为新增，移动或保留已有的命中不报。`redacted` 是前 4 个字符加长度。
- **index.md**：只列 `active` 页；空分组不输出；每行 `- [标题](pages/slug.md) — summary`，标题中的 `\`、`[`、`]` 转义。
- **log 行**：`<时间> <op> <slug> "<title>"`，`rename` 为 `rename <old>-><new>`；title 中的 `"`、`\` 用 `\` 转义。
- **validate**：与草案相比改为接收文件原文与调用方传入的 `now`（domain 不读时钟，0043），从而能报告解析失败。规则：`invalid_slug`（error）、`invalid_frontmatter`（error）、`secret`（error）、`stale_task`（warning，`active` 的 `task` 页 `updated` 距 `now` ≥ 30 天）。需要全部页面的规则（悬空链接、孤立页、`index.md` 不一致、`possible_duplicate`）由 `mwf-app` 用 `internal_links`、`render_index` 与 `mwf-search` 组合完成。

## 依赖

`regex`（secret 规则）、`sha2`（Rev）、`thiserror`。

## 禁止

文件系统、时钟、环境变量、进程；依赖任何 workspace 内 crate。
