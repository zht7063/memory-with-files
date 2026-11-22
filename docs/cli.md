# CLI 规格

> 状态：命令集合已接受（[0023](decisions/0023-write-commands-and-rev.md)、[0028](decisions/0028-read-commands-and-output.md)）；P2 已实现项目、读、写命令（`crates/mwf-cli`），输出格式见 [0050](decisions/0050-cli-output-and-usage-errors.md)。宿主集成命令在 P3 / P4 实现。

所有命令：从当前目录向上查找 `.mwf/`（`init` 除外）；`--json`（全局选项，子命令前后都可）输出结构化结果；退出码 0 / 1 / 2。

- 退出码：0 成功；1 操作失败（任何错误码，或 `lint` 有 error）；2 用法错误（`USAGE`）。`--help`、`--version` 退出 0。
- `--json`：一行 `{"ok":true,"data":…}` 或 `{"ok":false,"error":{"code":…,"message":…,"details":…}}`（`details` 可省略），总写到 stdout；用法错误也是如此。`lint` 有 error 时仍是 `"ok": true`，退出 1。
- 纯文本：结果写 stdout；错误写 stderr，格式 `error[CODE]: message`；用法错误为 clap 的文本（疑似密钥的参数被隐去）。stdout 写不进去时退出 1。各命令的格式由 `crates/mwf/tests/snapshots/` 固定（0050）。
- stdin 与 `--old-file` / `--new-file` 最多读 1 MB，超出即 `TOO_LARGE`（0033、0050）；不是 UTF-8 为 `INVALID_FIELD`。

## 项目

```
mwf init [--local]
```

在 git 仓库根目录创建 `.mwf/`。默认进 git 并写 `.gitattributes`（`log.md merge=union`）；`--local` 时把 `.mwf/` 写入 `.gitignore`。机器本地文件由 `.mwf/.gitignore` 忽略；`.mwf` 已存在时报错（[0048](decisions/0048-init-layout-and-ignore-rules.md)）。

## 读

```
mwf show <slug>                         frontmatter、正文、rev、出链、反向链接
mwf search <query>... [--type T]... [--tag t]... [--status active|archived|all] [--limit N]
                                        BM25 结果：slug、title、summary、score、rev
mwf list [--type T]... [--tag t]... [--status active|archived|all]
mwf index [--rebuild]                   打印由当前页面渲染的目录；--rebuild 同时重写 index.md（0049）
mwf log [-n N]                          最近 N 条写操作（默认 20）
mwf lint                                检查全部页面；有 error 时退出 1
```

## 写

所有写命令：持写锁 → 校验 → secret 扫描 → 原子写 → 重建 `index.md` → 追加 `log.md`；成功后输出新的 `rev`。

```
mwf new <slug> --type T --title "…" --summary "…" [--tag t]...    正文从 stdin
mwf write <slug> --rev R                                           正文从 stdin，整页替换
mwf patch <slug> --old "…" --new "…"                               也可 --old-file/--new-file
mwf set <slug> [--title …] [--type …] [--summary …] [--tag t]... [--untag t]...
mwf archive <slug>
mwf unarchive <slug>
mwf rename <old> <new>                                             改写所有指向 old.md 的内部链接
mwf delete <slug> [--unlink]                                       移入 .mwf/trash/
```

## 宿主集成

```
mwf hook <event> --host claude|codex     由宿主调用；读 stdin JSON，输出一行 JSON，总是退出 0
                                         event：session-start | prompt | stop | pre-tool（0051）
mwf install --host claude|codex
mwf uninstall --host claude|codex
```

## 错误码

| code | 含义 |
| --- | --- |
| `NOT_INITIALIZED` | 找不到 `.mwf/` |
| `NOT_GIT_ROOT` | `init` 不在 git 仓库根目录 |
| `ALREADY_INITIALIZED` | `init` 时 `.mwf` 已存在（不改动任何文件，[0048](decisions/0048-init-layout-and-ignore-rules.md)） |
| `NOT_FOUND` | 页面不存在 |
| `ALREADY_EXISTS` | `new` / `rename` 目标 slug 已存在 |
| `INVALID_SLUG` | slug 不符合 `[a-z0-9-]` |
| `INVALID_FIELD` | frontmatter 字段不合法（type 不在枚举内、summary 过长……） |
| `REV_MISMATCH` | `write` 的 rev 与当前不一致 |
| `PATCH_NO_MATCH` / `PATCH_AMBIGUOUS` | `patch` 旧串无匹配 / 多处匹配 |
| `SECRET_DETECTED` | 新增内容疑似密钥 |
| `HAS_BACKLINKS` | `delete` 时仍有入链 |
| `LOCK_TIMEOUT` | 等写锁超时 |
| `INVALID_PAGE` | 要读或改的页面文件本身不合法；运行 `mwf lint`（[0049](decisions/0049-app-defaults.md)） |
| `INVALID_CONFIG` | `.mwf/config.toml` 不合法（0049） |
| `TOO_LARGE` | 正文或 `patch` 的 old / new 超过 100 KB（[0033](decisions/0033-consistency-and-limits.md)、0049）；stdin 或 `--old-file` / `--new-file` 超过 1 MB（0050） |
| `CHANGED` | `.mwf` 或 `.mwf/.lock` 在使用中被替换（[0048](decisions/0048-init-layout-and-ignore-rules.md)） |
| `WRONG_FILE_TYPE` | `.mwf/` 下的路径是符号链接或类型不对（0048） |
| `IO` | 其他文件系统错误 |
| `USAGE` | 参数错误（退出码 2） |
