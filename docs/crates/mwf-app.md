# mwf-app

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

**职责**：用例层。每个操作一个函数：取锁 → 读 → domain 校验/扫描 → store 写 → 重建 index → 追加 log → 返回 DTO。适配器唯一的入口。对外只暴露自己的 DTO 与错误码，不透传 domain / store / search 类型（0015）。

## 公开 API（草案）

```rust
pub struct App { project: Project, clock: Box<dyn Clock> }   // Clock 可注入，测试用固定时间；系统时钟用 SystemTime + Timestamp::from_unix_secs（0046）
impl App {
    pub fn open(cwd: &Path) -> Result<App, AppError>;
    pub fn init(cwd: &Path, local: bool) -> Result<InitOut, AppError>;

    // 读
    pub fn show(&self, slug: &str) -> Result<PageView, AppError>;              // 含 rev、出入链（带标题与 summary，0040）
    pub fn search(&self, q: &SearchIn) -> Result<Vec<SearchHit>, AppError>;
    pub fn list(&self, q: &ListIn) -> Result<Vec<PageSummary>, AppError>;
    pub fn index(&self, rebuild: bool) -> Result<String, AppError>;
    pub fn log(&self, n: usize) -> Result<Vec<String>, AppError>;
    pub fn lint(&self) -> Result<LintReport, AppError>;

    // 写：都返回 WriteOut { slug, rev, warnings, related_unlinked }（0040）
    pub fn new_page(&self, i: NewIn) -> Result<WriteOut, AppError>;
    pub fn write(&self, i: WriteIn) -> Result<WriteOut, AppError>;
    pub fn patch(&self, i: PatchIn) -> Result<WriteOut, AppError>;
    pub fn set(&self, i: SetIn) -> Result<WriteOut, AppError>;
    pub fn archive(&self, slug: &str, archived: bool) -> Result<WriteOut, AppError>;
    pub fn rename(&self, from: &str, to: &str) -> Result<WriteOut, AppError>;
    pub fn delete(&self, slug: &str, unlink: bool) -> Result<DeleteOut, AppError>;

    // 给 hooks 用（0030, 0039, 0040）
    pub fn session_context(&self, max_chars: usize) -> Result<SessionContext, AppError>;
    pub fn recall(&self, session: &str, prompt: &str) -> Result<Vec<PageSummary>, AppError>;  // 含"每会话一次"
    pub fn is_inside_mwf(&self, path: &Path) -> bool;                          // PreToolUse 守卫
}

pub struct AppError { code: ErrorCode, message: String, details: serde_json::Value }
pub enum ErrorCode { NotInitialized, NotGitRoot, AlreadyInitialized, NotFound, AlreadyExists, InvalidSlug, InvalidField,
                     RevMismatch, PatchNoMatch, PatchAmbiguous, SecretDetected, HasBacklinks, LockTimeout, Io }
```

DTO 全部 `#[derive(Serialize)]`，`--json` 与快照测试直接使用。

## 依赖

`mwf-domain`、`mwf-store`、`mwf-search`、`mwf-assets`（init 模板）、`serde`、`serde_json`、`thiserror`。

## 禁止

参数解析、终端输出、宿主协议格式；依赖任何适配器。
