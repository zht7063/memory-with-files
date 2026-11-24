# CLI 规格

> 状态：命令集合已接受（[0023](decisions/0023-write-commands-and-rev.md)、[0028](decisions/0028-read-commands-and-output.md)）；P2 已实现项目、读、写命令（`crates/mwf-cli`），输出格式见 [0050](decisions/0050-cli-output-and-usage-errors.md)。宿主集成命令：`hook` 在 P3 实现（[0051](decisions/0051-hook-apis-and-session-state.md)），`install` / `uninstall` 在 P4 实现（[0052](decisions/0052-install-and-uninstall.md)）。

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

`list`、`search`（含 `--status all`）只包含能解析的页面；frontmatter 不合法的页面文件由 `lint` 报告，`show` 给出解析错误（[0053](decisions/0053-smoke-test-follow-ups.md)）。

## 写

所有写命令：持写锁 → 校验 → secret 扫描 → 原子写 → 重建 `index.md` → 追加 `log.md`；成功后输出新的 `rev`。正文按 stdin 原样存储，不做规范化：只差末尾换行也是改动（`updated`），写入相同字节才是 `unchanged`（0053）。

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

先安装 `mwf`：`brew install zht7063/tap/mwf`（仅正式版），或从 GitHub Release 下载 `mwf-<target>.tar.xz`（macOS / Linux musl 的 arm64 与 x86_64），见根目录 [README](../README.md#install) 与 [0054](decisions/0054-release-config.md)。

```
mwf hook <event> --host <host>     由宿主调用；读 stdin JSON，输出一行 JSON，总是退出 0
                                   event：session-start | prompt | stop | pre-tool（0051）
mwf install --host <host> [--dry-run]
mwf uninstall --host <host> [--dry-run]
```

`<host>`：`claude`、`codex`、`pi`、`antigravity`（别名 `agy`，[0055](decisions/0055-hosts-pi-and-antigravity.md)）。最低版本：pi 1.6.0；Antigravity CLI（`agy` 命令）1.5.16。`pi` 尚未实现。

这三条命令由 bin 在 clap 之前分发，不在 `mwf --help` 的 `Commands:` 中，帮助末尾的 `Host integration` 一段列出它们（0052、0053）。`uninstall` 不删除上一级的 `skills/`、`.agents/`、`extensions/`、`plugins/` 目录，也保留 `.mwf-bak-*` 备份（0052）。

`install` 把四个 hook（每个事件一条 `mwf hook <event> --host <host>`，超时 10 s）加入宿主的用户级配置，并写入 `mwf` skill；`uninstall` 只删除这些。`--dry-run` 只打印将要做的改动。文件位置（0031、0052、0055）：

- `claude`：`$CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下的 `settings.json` 与 `skills/mwf/`。
- `codex`：`$CODEX_HOME`（默认 `~/.codex`）下的 `hooks.json`；skill 在 `~/.agents/skills/mwf/`。安装（或更新了 hook）后在 Codex 的 `/hooks` 中信任 mwf 的 hooks。
- `pi`：`$PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）下的 `extensions/mwf/index.ts`，是把 pi 的事件转给 `mwf hook … --host pi` 的扩展；skill 在 `~/.agents/skills/mwf/`。
- `antigravity`：插件目录 `~/.gemini/config/plugins/mwf/`（`plugin.json`、`hooks.json`），对 Antigravity 的 CLI、App 与 IDE 都生效；skill 在 `~/.agents/skills/mwf/`。agy 在 PreToolUse hook 出错时会拦下工具调用：删除或移动 mwf 之前先运行 `mwf uninstall --host antigravity`。

`~/.agents/skills/mwf/` 由 `codex`、`pi`、`antigravity` 共用：`uninstall` 其中一个时，只要另一个还装着就保留 skill（0055）。

`install` 只能从名为 `mwf` 的二进制运行（`INVALID_EXECUTABLE`）。hook 命令写 `mwf`，除非 `PATH` 上第一个 `mwf` 不是本二进制、`PATH` 上没有，或其前面有相对目录，这时写本二进制的路径。

修改或删除已有文件前备份为同目录的 `<文件名>.mwf-bak-<时间>`（0600）；写入是原子的，途经的目录在写入前重新核对身份；基准目录（`HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`PI_CODING_AGENT_DIR`）之下的符号链接一律拒绝；不读写任何项目的 `.mwf/`。退出码与 `--json` 同上；输出格式见 0052。

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
| `SECRET_DETECTED` | 新增内容疑似密钥；行号是页面文件（含 frontmatter）的行号（0049、0053） |
| `HAS_BACKLINKS` | `delete` 时仍有入链 |
| `LOCK_TIMEOUT` | 等写锁超时 |
| `INVALID_PAGE` | 要读或改的页面文件本身不合法；运行 `mwf lint`（[0049](decisions/0049-app-defaults.md)） |
| `INVALID_CONFIG` | `.mwf/config.toml` 不合法（0049） |
| `TOO_LARGE` | 正文或 `patch` 的 old / new 超过 100 KB（[0033](decisions/0033-consistency-and-limits.md)、0049）；stdin 或 `--old-file` / `--new-file` 超过 1 MB（0050） |
| `CHANGED` | `.mwf` 或 `.mwf/.lock` 在使用中被替换（[0048](decisions/0048-init-layout-and-ignore-rules.md)）；`install` / `uninstall` 时宿主文件在写入前被别人改了（0052） |
| `WRONG_FILE_TYPE` | `.mwf/` 下的路径是符号链接或类型不对（0048）；宿主的文件或目录是符号链接或类型不对（0052） |
| `HOST_CONFIG_INVALID` | 宿主的 `settings.json` / `hooks.json` 不是严格 JSON（含只有空白的文件）或形状不对；不改动任何文件（0052） |
| `INVALID_EXECUTABLE` | `install` 的二进制不叫 `mwf`：hooks 按这个名字认出（0052） |
| `INVALID_ENV` | `HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`PI_CODING_AGENT_DIR` 未设置、不是绝对路径或不是目录（0052） |
| `IO` | 其他文件系统错误 |
| `USAGE` | 参数错误（退出码 2） |
