# 0048 `init` 的布局、忽略规则与已有 `.mwf/`

- 状态：已接受（2026-11-22）；细化 [0017](0017-page-model.md)、[0019](0019-git-and-project-root.md)、[0026](0026-delete-to-trash.md)、[0029](0029-log-format-and-merge.md)、[0013](0013-atomic-write-file-lock.md)、[0039](0039-bm25-scoring-and-relevance.md)

## 背景

P2 实现 `mwf-store` 时，几处细节在已有 ADR 中没有规定：怎样判断 git 根、机器本地文件的忽略规则写在哪里、在已有 `.mwf/` 的目录再次 `init` 怎么办、`init` 中途失败或并发时怎样、符号链接、`log.md` 怎样追加、`trash/` 重名、`config.toml` 的未知键与形状。

## 决定

### git 根

- `<dir>/.git` 是目录，或是以 `gitdir:` 开头的文件（linked worktree、子模块），`<dir>` 就是 git 根。不调用 `git` 程序。
- 否则 `NOT_GIT_ROOT`；`<dir>` 在某个仓库内部时，错误信息给出仓库根。

### `init` 生成的内容

| 路径 | 内容 |
| --- | --- |
| `.mwf/.gitignore` | 两种模式都写，见下 |
| `.mwf/config.toml` | 全部配置项及默认值，带注释 |
| `.mwf/index.md` | 无页面时的目录（与之后重建的结果一致，首次写入不产生多余 diff） |
| `.mwf/log.md` | 空文件 |
| `.mwf/pages/` | 空目录 |

- `trash/`、`.lock`、`.state/` 在用到时创建。
- git 不保存空目录，克隆后可能没有 `pages/`：读取时视为没有页面，写入时自动创建。

### 忽略规则

- `.mwf/.gitignore`（两种模式都写）：

  ```
  /.lock
  /.state/
  /trash/
  .*.tmp
  ```

  `.*.tmp` 是中断的原子写留下的临时文件。规则随 `.mwf/` 走，git 模式下不改动用户的根 `.gitignore`；`--local` 项目以后改为进 git 时，机器本地文件仍被忽略。
- git 模式：根 `.gitattributes` 追加 `.mwf/log.md merge=union`（0029）。
- `--local`：根 `.gitignore` 追加 `/.mwf/`（以 `/` 锚定在仓库根，不误伤子目录里的同名目录）。
- 只有当文件的**最后一条规则**（最后一个非空、非 `#` 注释的行，去掉行尾 `\r`）恰好是这一行时才不追加，否则总是追加到末尾。理由：这两个文件中后面的规则覆盖前面的（`!/.mwf/` 取消忽略、`*.md -merge` 取消 union），别处出现相同或"等价"的行（如 `  .mwf  `，git 不去掉行尾以外的空白）都不能证明规则生效。原有内容保留；原文件缺末尾换行时先补上。

### 已有 `.mwf`

- `.mwf` 已存在（目录、文件或符号链接）时，`init` 返回新错误码 `ALREADY_INITIALIZED`（退出 1），不改动任何文件。
- 理由：`init` 不去猜意图（切换模式、修复缺失文件）。缺失的 `config.toml`、`log.md`、`pages/` 本来就按缺省处理，`index.md` 由 `mwf index --rebuild` 重建；切换模式由用户手动改 `.gitignore` / `.gitattributes`。

### 先暂存、后发布

- 同一根目录的 `init` 用根目录本身的独占锁（`File::lock` 加在根目录的句柄上，最多等 2 秒，不在仓库里创建文件）串行化；拿到锁后再检查 `.mwf`，只有看到 `.mwf` 不存在的 `init` 才写任何东西。因此并发的 git 模式与 `--local` 的 `init` 只留下胜者的 Git 规则。
- `init` 先在根目录建暂存目录 `.mwf.<pid>.<序号>.tmp`（`find` 只认 `.mwf`，看不到它），写好全部文件并 fsync，再写根 `.gitattributes` / `.gitignore` 的规则，最后把暂存目录 rename 为 `.mwf` 并 fsync 根目录。
- 因此 `find` 要么找不到项目，要么看到完整且 Git 规则已就位的项目；rename **之前**失败时删除暂存目录、不留下 `.mwf`，可以直接重试（根 `.gitignore` / `.gitattributes` 中已追加的规则保留，重试时最后一条规则已是它，不再重复）。rename 之后根目录 fsync 失败时返回错误，但项目已经发布，重试得到 `ALREADY_INITIALIZED`。
- rename 不会覆盖文件、符号链接或非空目录：另一个 `init` 抢先发布、或已有进程在写的项目不会被替换，此时返回 `ALREADY_INITIALIZED`。

### 符号链接与文件类型

- `.mwf`、`pages/`、`trash/` 必须是真实目录，页面、`config.toml`、`index.md`、`log.md`、`.lock` 必须是普通文件；检查时不跟随符号链接。符号链接、特殊文件、或目录与文件互换时报 `WrongFileType`，读写都不进行，避免提交进仓库的符号链接让 mwf 读写项目以外的文件。
- `find` 遇到名为 `.mwf` 的普通文件时跳过继续向上；遇到 `.mwf` 符号链接时报错。
- `pages/` 下以 `.md` 结尾但不是普通文件的条目同样报错（`read_page`、`read_all_pages`、写入一致），不以 `.md` 结尾的条目（含临时文件）跳过。
- 项目根本身可以经由符号链接到达：`find` / `init` 先 canonicalize。
- `Project` 持有 `.mwf` 目录的打开句柄（`Arc<File>`，`Project` 仍可 `Clone`）。句柄让该 inode 一直存活，删除后重建的 `.mwf` 不可能复用同一（设备号, inode）；只记数字是不够的，Linux 上删除重建的目录常常拿回同一个 inode。之后每次读写、取锁都先用 `symlink_metadata` 核对 `.mwf` 路径仍指向句柄所在的目录（同一设备号与 inode，且是目录），再检查 `pages/` / `trash/` 与目标文件不是符号链接；`.mwf` 被删除、重建、换成符号链接或另一个目录时报 `Changed`，什么都不读写。
- `WriteGuard` 记下它锁住的 `.lock` 句柄与路径，**每次写入前**核对 `.lock` 路径仍是被锁的那个文件。`.lock` 被删除或替换（例如工作区清理删掉了被忽略的文件）后，另一个进程可以锁住新文件，原 guard 不再互斥，因此报 `Changed` 并停止写入；取锁后的首次核对也如此。
- 这是“失败即停”的检查，不是基于目录句柄的 `openat`：标准库没有相对目录句柄的 no-follow 操作，也不为此引入 `libc` / `rustix`。检查与使用之间仍有极短的窗口。它针对的是非恶意的并发工作区（编辑器、git 操作、清理脚本与 mwf 同时运行），不是对“运行中主动替换路径”的攻击者做隔离；提交进仓库或事先放好的符号链接总会被拒绝。

### 写入细节

- 原子写的临时文件与目标同目录，名为 `.<文件名>.<pid>.<序号>.tmp`，用 `create_new` 创建；名字已被占用（如同 pid 的已死进程留下的）时换下一个序号重试（最多 100 次），从不删除不是本次创建的文件。写入后 fsync 文件、rename、再 fsync 目录；目标已存在时沿用其权限。
- rename 之前失败：删除本次创建的临时文件，目标不变。rename 之后目录 fsync 失败：返回错误，但新内容已经可见，只是崩溃后能否保留不确定。
- 新建目录（`init` 的暂存目录与 `pages/`、写入时补建的 `pages/` / `trash/`）后 fsync 其父目录。
- `log.md` 的追加同样用原子替换整个文件（0013 的"每个文件"），不用 `O_APPEND`：不加锁的读者（hook）不会读到半行；union 合并留下的缺失末尾换行先补上。
- 写锁用 `File::try_lock` 每 10 ms 重试一次，最多等 2 秒（0033）。`LOCK_TIMEOUT` 的信息给出被锁的路径：写命令是 `.mwf/.lock`，`init` 是仓库根目录。锁随 `WriteGuard` 释放，进程退出时由操作系统释放。
- `WriteGuard` 的写方法都取 `&mut self`：同一把锁内的写由借用检查串行化，不会出现两个线程经同一个 guard 读-改-写 `log.md` 而丢行。
- `trash/<slug>.<ts>.md` 已存在（同一秒内两次删除同一 slug）时依次改用 `<slug>.<ts>.1.md`、`.2.md`……，不覆盖先前删除的页面。

### `config.toml`

- 文件不存在时全部取默认值；缺少的表或键取默认值。
- 未知的表或键、类型不对的值都报错，避免拼错的键悄悄回落到默认值。
- 顶层的每个键都必须是表（`[hooks]` 或内联表）：serde 会把数组按位置填进结构体（`hooks = [4, 5, false, 9]`）或把空数组当默认值（`hooks = []`），这两种写法都报错。

## 后果

- [cli.md](../cli.md) 的错误码表增加 `ALREADY_INITIALIZED`；[mwf-app](../crates/mwf-app.md) 的 `ErrorCode` 增加 `AlreadyInitialized`。
- 细节记录在 [crates/mwf-store.md](../crates/mwf-store.md)。
