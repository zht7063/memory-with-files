# mwf-app

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

**职责**：用例层。每个操作一个函数：取锁 → 读 → domain 校验/扫描 → store 写 → 重建 index → 追加 log → 返回 DTO。适配器唯一的入口。对外只暴露自己的 DTO 与错误码，不透传 domain / store / search 类型（0015）。

## 公开 API

P2 已实现（`crates/mwf-app`）除 hooks 用的三个函数外的全部内容；默认值与细节见 [0049](../decisions/0049-app-defaults.md)。

```rust
pub trait Clock: Send + Sync { fn now_unix_secs(&self) -> u64; }   // 0043、0046
pub struct SystemClock;                        // SystemTime::now()，早于 1970 读作 0
pub struct FixedClock(pub u64);                // 测试与快照

pub struct App { project: Project, clock: Box<dyn Clock> }
impl App {
    pub fn open(cwd: &Path) -> Result<App, AppError>;                          // SystemClock
    pub fn open_with_clock(cwd: &Path, clock: Box<dyn Clock>) -> Result<App, AppError>;
    pub fn init(cwd: &Path, local: bool) -> Result<InitOut, AppError>;         // InitOut { root, mode: "git"|"local", next_steps }
    pub fn root(&self) -> &Path;

    // 读（不加锁，0033）
    pub fn show(&self, slug: &str) -> Result<PageView, AppError>;              // 含 rev、出入链（带标题与 summary，0040）
    pub fn search(&self, q: &SearchIn) -> Result<Vec<SearchHit>, AppError>;
    pub fn list(&self, q: &ListIn) -> Result<Vec<PageSummary>, AppError>;
    pub fn index(&self, rebuild: bool) -> Result<String, AppError>;            // 由当前页面渲染；rebuild 时取锁重写 index.md，不记日志
    pub fn log(&self, n: usize) -> Result<Vec<String>, AppError>;
    pub fn lint(&self) -> Result<LintReport, AppError>;

    // 写：都返回 WriteOut（0040）
    pub fn new_page(&self, i: NewIn) -> Result<WriteOut, AppError>;
    pub fn write(&self, i: WriteIn) -> Result<WriteOut, AppError>;
    pub fn patch(&self, i: PatchIn) -> Result<WriteOut, AppError>;
    pub fn set(&self, i: SetIn) -> Result<WriteOut, AppError>;
    pub fn archive(&self, slug: &str, archived: bool) -> Result<WriteOut, AppError>;
    pub fn rename(&self, from: &str, to: &str) -> Result<WriteOut, AppError>;
    pub fn delete(&self, slug: &str, unlink: bool) -> Result<DeleteOut, AppError>;

    // P3，给 hooks 用（0030, 0039, 0040）
    // pub fn session_context(&self, max_chars: usize) -> Result<SessionContext, AppError>;
    // pub fn recall(&self, session: &str, prompt: &str) -> Result<Vec<PageSummary>, AppError>;  // 含"每会话一次"
    // pub fn is_inside_mwf(&self, path: &Path) -> bool;                       // PreToolUse 守卫
}

pub struct WriteOut { slug, rev, changed: bool, warnings: Vec<Warning>, related_unlinked: Vec<RelatedPage>, also_updated: Vec<String> }
pub struct DeleteOut { slug, trashed /* 相对项目根 */, unlinked: Vec<String>, warnings }
pub struct PageView { slug, rev, title, type, summary, tags, status, created, updated, body, links_out: Vec<LinkRef>, links_in: Vec<LinkRef> }
pub struct LinkRef { slug, exists: bool, title: Option<String>, summary: Option<String> }
pub struct SearchIn { query, types, tags, status: StatusFilter, limit }       // Default：active、limit 10
pub struct ListIn { types, tags, status }                                    // types 任一、tags 全部
pub struct LintReport { issues: Vec<LintIssue>, errors, warnings }           // LintIssue { page: Option<String>, rule, severity, message }

pub const BODY_MAX_BYTES: usize = 102_400;       // 0033、0049
pub const RELATED_LIMIT: usize = 3;              // 0040
pub const RELATED_MIN_TERMS: usize = 2;          // 0049
pub const DUPLICATE_SIMILARITY: f32 = 0.8;       // 0049

pub struct AppError { pub code: ErrorCode, pub message: String, pub details: serde_json::Value }
pub enum ErrorCode { NotInitialized, NotGitRoot, AlreadyInitialized, NotFound, AlreadyExists, InvalidSlug, InvalidField,
                     InvalidPage, InvalidConfig, RevMismatch, PatchNoMatch, PatchAmbiguous, SecretDetected, HasBacklinks,
                     TooLarge, LockTimeout, Changed, WrongFileType, Io }      // 序列化为 NOT_FOUND 等；ErrorCode::ALL
```

DTO 全部 `#[derive(Serialize)]`，`--json` 与快照测试直接使用；`type`、`status`、时间戳与 rev 都是字符串。`AppError` 序列化为 `{code, message, details}`（`details` 为空时省略）。

## 实现说明

- 每个操作读一次全部页面（`Corpus`）。名字不是 slug、不是 UTF-8 或解析失败的页面文件仍算“存在”（不是悬空链接目标），但不参与链接图、`index.md` 与检索；lint 报告它们。
- 写入在锁内重新读取全部页面、`index.md` 与 `log.md`（文件类型预检），校验、secret 扫描（正文、frontmatter 与目标 slug）与 100 KB 检查（含 `rename` / `--unlink` 改写的正文）都在任何写入之前完成；失败时什么都不落盘。`log.md` 中疑似密钥的标题被替换。`index.md` 只在内容不同时重写，然后追加一行日志。
- `write` 的 `rev` 与当前文件内容的 rev 不同为 `REV_MISMATCH`，`details.current_rev` 给出当前 rev。
- 错误码映射、上限、no-op 写入、`rename` / `delete --unlink` 的改写范围、`related_unlinked` 与 `possible_duplicate` 的门槛、lint 规则名与性能见 [0049](../decisions/0049-app-defaults.md)。

## 依赖

`mwf-domain`、`mwf-store`、`mwf-search`、`mwf-assets`（init 提示文本）、`serde`（derive，与 store 一样精确固定为 `=1.0.228`）、`serde_json`、`thiserror`。开发依赖：`tempfile`。

## 禁止

参数解析、终端输出、宿主协议格式；依赖任何适配器。
