# mwf-store

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

**职责**：`.mwf/` 的全部文件 IO：布局、项目定位、原子写、写锁、配置、日志、trash、会话状态。不含业务规则（校验、扫描在 domain，编排在 app）。

## 公开 API

P2 已实现（`crates/mwf-store`）除会话状态外的全部内容；与最初草案的差异见下方“实现说明”。

```rust
pub struct Project { root: PathBuf }           // root = 含 .mwf/ 的目录（已 canonicalize）
impl Project {
    pub fn find(cwd: &Path) -> Result<Project, StoreError>;           // 向上查找（0019）
    pub fn init(root: &Path, mode: GitMode) -> Result<Project, StoreError>;  // 0048
    pub fn root(&self) -> &Path;
    pub fn mwf_dir(&self) -> PathBuf;
    pub fn config(&self) -> Result<Config, StoreError>;               // config.toml，缺省值见 0039
    pub fn read_page(&self, slug: &Slug) -> Result<Option<Vec<u8>>, StoreError>;
    pub fn read_all_pages(&self) -> Result<Vec<(String, Vec<u8>)>, StoreError>;  // 不加锁（0033）
    pub fn read_index(&self) -> Result<Option<Vec<u8>>, StoreError>;
    pub fn read_log(&self, n: usize) -> Result<Vec<String>, StoreError>;
    pub fn lock(&self, timeout: Duration) -> Result<WriteGuard<'_>, StoreError>; // File::lock（0013）
    // P3：pub fn session(&self, id: &str) -> SessionStore<'_>;      // .mwf/.state/（0034）
}
pub const LOCK_WAIT: Duration = Duration::from_secs(2);              // 0033

impl WriteGuard<'_> {                          // 只有持锁才能写；写方法取 &mut self
    pub fn project(&self) -> &Project;
    pub fn write_page(&mut self, slug: &Slug, bytes: &[u8]) -> Result<(), StoreError>;    // 临时文件+fsync+rename
    pub fn move_to_trash(&mut self, slug: &Slug, ts: &Timestamp) -> Result<PathBuf, StoreError>;
    pub fn rename_page(&mut self, from: &Slug, to: &Slug) -> Result<(), StoreError>;
    pub fn write_index(&mut self, text: &str) -> Result<(), StoreError>;
    pub fn append_log(&mut self, line: &str) -> Result<(), StoreError>;
}

pub struct Config { pub hooks: HooksConfig }
pub struct HooksConfig { pub recall_min_terms: usize, pub recall_top_k: usize,
                         pub stop_reminder: bool, pub session_start_max_chars: usize }
pub const DEFAULT_CONFIG_TOML: &str;          // init 写入的 config.toml
pub const MWF_GITIGNORE: &str;                // init 写入的 .mwf/.gitignore
pub enum GitMode { Track, Local }

pub enum StoreError { NotInitialized { start }, NotGitRoot { path, git_root }, AlreadyInitialized { path },
                      LockTimeout { path, waited }, Config { path, message }, PageNotFound { slug },
                      PageExists { slug }, WrongFileType { path, expected }, Changed { path },
                      Io { path, source } }
```

## 实现说明

- **布局**：`.mwf/` 下为 `.gitignore`、`config.toml`、`index.md`、`log.md`、`pages/<slug>.md`、`trash/`、`.lock`（0017、0048）。`pages/` 缺失视为没有页面，写入时自动创建（git 不保存空目录）。
- **`find`**：先 canonicalize `cwd`（解析 `..` 与符号链接），再取最近的含 `.mwf/` **目录**的祖先；名为 `.mwf` 的普通文件跳过，`.mwf` 符号链接为 `WrongFileType`。找不到为 `NotInitialized`。
- **`init`**：见 [0048](../decisions/0048-init-layout-and-ignore-rules.md)。参数由草案的 `git_root` 改名为 `root`：调用方传当前目录，由 store 判断它是不是 git 根（`.git` 目录或 `gitdir:` 文件，不调用 `git`）；不是时 `NotGitRoot`，在仓库内部时带上仓库根。`.mwf` 已存在时 `AlreadyInitialized`，不改动任何文件。先在暂存目录 `.mwf.<pid>.<序号>.tmp` 中建好全部文件、再写根目录的 Git 规则（只在它不是最后一条规则时追加），最后 rename 发布：`find` 只会看到完整的项目。同一根目录的 `init` 由根目录句柄上的 `File::lock` 串行化，锁内再查 `.mwf`，并发的 `init`（包括不同模式）只有一个成功、只写它的 Git 规则。rename 前失败时不留下 `.mwf`、可以重试；rename 后根目录 fsync 失败时返回错误但项目已发布。
- **原子写**：同目录临时文件 `.<文件名>.<pid>.<序号>.tmp`（`create_new`，名字被占用时换序号重试，不删别人的文件）→ 写入 → fsync → rename → fsync 目录；沿用被替换文件的权限；rename 前失败时删除本次创建的临时文件、目标不变；rename 后目录 fsync 失败时返回错误，新内容已可见但持久性不确定。新建的 `pages/`、`trash/` 会 fsync `.mwf/`。`log.md`、根 `.gitignore` / `.gitattributes` 的追加也是读出、追加、原子替换。
- **文件类型**：`.mwf`、`pages/`、`trash/` 须是真实目录，页面、`config.toml`、`index.md`、`log.md`、`.lock` 须是普通文件，检查不跟随符号链接；否则 `WrongFileType`，读写都不进行（0048）。
- **目录身份**：`Project` 持有 `.mwf` 的打开句柄（`Arc<File>`，固定住 inode，删除重建的 `.mwf` 不能复用它）；每次读写与取锁前核对 `.mwf` 路径仍是句柄所在的真实目录，否则 `Changed`。`WriteGuard` 每次写入前核对 `.lock` 路径仍是它锁住的文件，被删除或替换时 `Changed`。这是失败即停的路径检查，面向非恶意的并发工作区，不是 `openat` 式的隔离（0048）。
- **锁**：`.mwf/.lock` 上的 `File::try_lock`，每 10 ms 重试，超过 `timeout` 返回 `LockTimeout { path }`（写命令用 `LOCK_WAIT` = 2 秒；`init` 等的是仓库根目录的锁，`path` 是根目录）。锁文件不删除；锁随 `WriteGuard` drop 或进程退出释放。读方法不需要锁，持锁期间也可通过 `WriteGuard::project` 读取。写方法取 `&mut self`，同一 guard 上的写由借用检查串行化（`WriteGuard` 文档中有 compile_fail 示例）。
- **`read_all_pages`**：与草案不同，返回文件名（去掉 `.md`）而不是 `Slug`，按名字排序，不校验 slug，使 lint 能报告 `invalid_slug`（`validate` 接收 `file_stem`）。只读 `pages/` 下以 `.md` 结尾的条目，跳过其他名字（含临时文件）；以 `.md` 结尾却不是普通文件（目录、符号链接）为 `WrongFileType`。
- **`read_index`**：草案中没有；`mwf index`（不带 `--rebuild`）、SessionStart 与 lint 的 `index.md` 一致性检查需要读它。
- **`read_log(n)`**：最后 `n` 个非空行，旧的在前；文件不存在为空。非 UTF-8 字节按 lossy 解码。
- **`append_log(line)`**：`line` 是 `render_log_line` 的结果（单行、不含换行）；原文件缺末尾换行（union 合并可能留下）时先补上；`log.md` 不存在时创建。
- **`move_to_trash`**：`trash/<slug>.<ts>.md`，返回新路径；重名时改用 `<slug>.<ts>.1.md`、`.2.md`……；页面不存在为 `PageNotFound`。
- **`rename_page`**：只移动文件、不改内容；目标已存在为 `PageExists`，不覆盖。
- **配置**：缺文件、缺表、缺键都取默认值（0039）；未知键、类型错误、顶层键不是表（`hooks = []`、`hooks = [4, 5, false, 9]`）、非 UTF-8 为 `Config` 错误，`message` 只含 TOML 解析器给出的原因，不含原文片段。`mwf-app` 把它映射为 `INVALID_CONFIG`（[0049](../decisions/0049-app-defaults.md)）。
- **错误**：`StoreError` 用 `thiserror`；`Io` 带出错的路径。各变体对应的 CLI 错误码：`NotInitialized` → `NOT_INITIALIZED`、`NotGitRoot` → `NOT_GIT_ROOT`、`AlreadyInitialized` → `ALREADY_INITIALIZED`、`LockTimeout` → `LOCK_TIMEOUT`、`PageNotFound` → `NOT_FOUND`、`PageExists` → `ALREADY_EXISTS`、`Config` → `INVALID_CONFIG`、`WrongFileType` → `WRONG_FILE_TYPE`、`Changed` → `CHANGED`、`Io` → `IO`（0049）。
- **会话状态**（`.mwf/.state/`，0034）留到 P3 与 hooks 一起实现；`.mwf/.gitignore` 已忽略 `.state/`。

## 依赖

`mwf-domain`（`Slug`、`Timestamp`、`render_index`）、`toml`（只开 `parse`、`serde`、`std`）、`serde`（derive）、`serde_json`（会话状态，P3 引入，[0046](../decisions/0046-pre-p0-doc-fixes.md)）、`thiserror`。开发依赖：`tempfile`。

`serde` 在 `Cargo.toml` 中精确固定为 `=1.0.228`：1.0.229 的 `serde_derive` 依赖 `syn` 3，而 `divan`、`thiserror-impl` 依赖 `syn` 2，`deny.toml` 禁止重复主版本。

## 禁止

业务校验与决策；依赖 search / app 及以上。
