# 0048 `init` 的布局、忽略规则与已有 `.mwf/`

- 状态：已接受（2026-11-22）；细化 [0017](0017-page-model.md)、[0019](0019-git-and-project-root.md)、[0026](0026-delete-to-trash.md)、[0029](0029-log-format-and-merge.md)、[0013](0013-atomic-write-file-lock.md)、[0039](0039-bm25-scoring-and-relevance.md)

## 背景

P2 实现 `mwf-store` 时，几处细节在已有 ADR 中没有规定：怎样判断 git 根、机器本地文件的忽略规则写在哪里、在已有 `.mwf/` 的目录再次 `init` 怎么办、`log.md` 怎样追加、`trash/` 重名、`config.toml` 的未知键。

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
- 已有等价的行（忽略首尾与连续空白；`.gitignore` 中的 `.mwf`、`.mwf/`、`/.mwf`、`/.mwf/`，`.gitattributes` 中的 `/.mwf/log.md merge=union`）时不重复追加。原有内容保留；原文件缺末尾换行时先补上。

### 已有 `.mwf`

- `.mwf` 已存在（目录或文件）时，`init` 返回新错误码 `ALREADY_INITIALIZED`（退出 1），不改动任何文件。
- 理由：`init` 不去猜意图（切换模式、修复缺失文件）。缺失的 `config.toml`、`log.md`、`pages/` 本来就按缺省处理，`index.md` 由 `mwf index --rebuild` 重建；切换模式由用户手动改 `.gitignore` / `.gitattributes`。

### 写入细节

- 原子写的临时文件与目标同目录，名为 `.<文件名>.<pid>.<序号>.tmp`；写入后 fsync 文件、rename、再 fsync 目录；目标已存在时沿用其权限；失败时删除临时文件，目标不变。
- `log.md` 的追加同样用原子替换整个文件（0013 的"每个文件"），不用 `O_APPEND`：不加锁的读者（hook）不会读到半行；union 合并留下的缺失末尾换行先补上。
- 写锁用 `File::try_lock` 每 10 ms 重试一次，最多等 2 秒（0033）。锁随 `WriteGuard` 释放，进程退出时由操作系统释放。
- `trash/<slug>.<ts>.md` 已存在（同一秒内两次删除同一 slug）时依次改用 `<slug>.<ts>.1.md`、`.2.md`……，不覆盖先前删除的页面。

### `config.toml`

- 文件不存在时全部取默认值；缺少的表或键取默认值。
- 未知的表或键、类型不对的值都报错，避免拼错的键悄悄回落到默认值。

## 后果

- [cli.md](../cli.md) 的错误码表增加 `ALREADY_INITIALIZED`；[mwf-app](../crates/mwf-app.md) 的 `ErrorCode` 增加 `AlreadyInitialized`。
- 细节记录在 [crates/mwf-store.md](../crates/mwf-store.md)。
