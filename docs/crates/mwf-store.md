# mwf-store

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

**职责**：`.mwf/` 的全部文件 IO：布局、项目定位、原子写、写锁、配置、日志、trash、会话状态。不含业务规则（校验、扫描在 domain，编排在 app）。

## 公开 API（草案）

```rust
pub struct Project { root: PathBuf }           // root = 含 .mwf/ 的目录
impl Project {
    pub fn find(cwd: &Path) -> Result<Project, StoreError>;           // 向上查找（0019）
    pub fn init(git_root: &Path, mode: GitMode) -> Result<Project, StoreError>;
    pub fn config(&self) -> Result<Config, StoreError>;               // config.toml，缺省值见 0039
    pub fn read_page(&self, slug: &Slug) -> Result<Option<Vec<u8>>, StoreError>;
    pub fn read_all_pages(&self) -> Result<Vec<(Slug, Vec<u8>)>, StoreError>;   // 不加锁（0033）
    pub fn read_log(&self, n: usize) -> Result<Vec<String>, StoreError>;
    pub fn lock(&self, timeout: Duration) -> Result<WriteGuard<'_>, StoreError>; // File::lock（0013）
    pub fn session(&self, id: &str) -> SessionStore<'_>;              // .mwf/.state/（0034）
}

impl WriteGuard<'_> {                          // 只有持锁才能写
    pub fn write_page(&self, slug: &Slug, bytes: &[u8]) -> Result<(), StoreError>;    // 临时文件+fsync+rename
    pub fn move_to_trash(&self, slug: &Slug, ts: &Timestamp) -> Result<(), StoreError>;
    pub fn rename_page(&self, from: &Slug, to: &Slug) -> Result<(), StoreError>;
    pub fn write_index(&self, text: &str) -> Result<(), StoreError>;
    pub fn append_log(&self, line: &str) -> Result<(), StoreError>;
}

pub struct Config { hooks: HooksConfig }
pub enum GitMode { Track, Local }
```

## 依赖

`mwf-domain`（`Slug`、`Timestamp`）、`toml`、`serde`、`thiserror`。

## 禁止

业务校验与决策；依赖 search / app 及以上。
