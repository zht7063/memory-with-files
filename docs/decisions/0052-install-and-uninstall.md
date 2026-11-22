# 0052 install / uninstall 的文件、条目、安全边界与输出

- 状态：已接受（2026-11-22）；细化 [0024](0024-bypass-guard.md)、[0031](0031-install-scope.md)、[0036](0036-skill-organization.md)、[0037](0037-lifecycle-safety.md)、[0042](0042-dependency-policy.md)、[0050](0050-cli-output-and-usage-errors.md)、[0051](0051-hook-apis-and-session-state.md)

## 背景

P4 实现 `mwf-lifecycle` 前，下列细节在已有 ADR 中没有规定：Codex 的 skill 放在哪里、写入宿主文件的条目长什么样、怎样认出 mwf 的条目、符号链接检查从哪一级开始、skill 目录归谁、备份的名字、`uninstall` 清理到什么程度、宿主目录不存在时怎么办、`--json` 与错误码、参数解析与 `--help`。

已查证的宿主事实（2026-11-22）：

- Claude Code（code.claude.com/docs/en/hooks）：hooks 在 `settings.json` 的 `hooks.<Event>[]`，每项是 `{matcher?, hooks: [handler…]}`；command handler 有 `type`、`command`、`timeout`（秒）等字段；UserPromptSubmit、Stop 不支持 matcher。用户级 skill 在 `~/.claude/skills/<name>/SKILL.md`，`CLAUDE_CONFIG_DIR` 替换 `~/.claude`。
- Codex（developers.openai.com/codex/hooks、/codex/skills）：用户级 hooks 在 `$CODEX_HOME/hooks.json`（默认 `~/.codex/hooks.json`），形状与 Claude 相同；PreToolUse 的 matcher 匹配工具名，`apply_patch` 也可写作 `Edit` / `Write`；新的或改过的非托管 hook 要在 `/hooks` 中信任后才运行。用户级 skill 在 **`$HOME/.agents/skills`**；`$CODEX_HOME/skills` 是已弃用、仅为兼容而读取的旧位置。

## 决定

### 文件

| 宿主 | hooks | skill |
| --- | --- | --- |
| `claude` | `$CLAUDE_CONFIG_DIR/settings.json`，未设置时 `~/.claude/settings.json` | `$CLAUDE_CONFIG_DIR/skills/mwf/`，未设置时 `~/.claude/skills/mwf/` |
| `codex` | `$CODEX_HOME/hooks.json`，未设置时 `~/.codex/hooks.json` | `~/.agents/skills/mwf/`（不随 `CODEX_HOME` 变化） |

- 环境变量为空视同未设置；不是绝对路径为 `INVALID_ENV`。需要 `HOME` 而它未设置或不是绝对路径时也是 `INVALID_ENV`。
- “基准目录”是 `HOME`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME` 本身：它必须已存在且是目录（否则 `INVALID_ENV`，不替用户创建一个可能拼错的目录）；它之下缺少的目录（`.claude/`、`.codex/`、`.agents/skills/mwf/` 等）在写入时逐级创建。
- 只写用户级（0031）；从不读写项目的 `.mwf/` 或项目里的宿主配置。

### 条目

- 每个事件一个 matcher 组，组里一个 handler：`{"type": "command", "command": "<mwf> hook <event> --host <host>", "timeout": 10}`（0051 的 10 s）。PreToolUse 的 matcher：Claude `Edit|Write|MultiEdit|NotebookEdit|Bash`，Codex `apply_patch|Bash`（0024）；其余三个事件不写 matcher。
- **认出 mwf 的条目**：`type` 为 `command`，且 `command` 只用引号（无展开、重定向、管道、`;` 等）时拆出的词恰好是 `<文件名为 mwf 的路径> hook <四个事件之一> --host <本宿主>`。不看 `statusMessage` 之类用户可见的字段；`--host` 必须是本宿主，所以 `uninstall --host claude` 不会碰到同一文件里 Codex 的条目，反之亦然。
- `install`：某事件已有恰好一个 mwf 条目、且它所在的组与要写的组相同时，什么都不改（`unchanged`）——Codex 按定义信任 hook，不改就不必重新信任。否则删掉该事件里所有 mwf 条目（以及因此变空的组），把新组放在原先第一个 mwf 条目所在组的位置，没有则追加到末尾（`added` / `updated`）。缺少的 `hooks` 对象与事件数组追加在已有键之后。
- `uninstall`：删掉 mwf 条目、因此变空的组、因此变空的事件数组，以及因此变空的 `hooks` 对象；用户原本就为空的组或数组不动。删完后整个文档是 `{}` 时删除文件（文件里只有 mwf 的东西，删掉不丢用户任何内容，因此不备份）。
- 四个事件都没有变化时**不写文件**，文件的字节保持原样。

### 保留用户的文件

- 只接受严格 JSON（RFC 8259）：注释、尾随逗号、BOM、重复键、多余内容都拒绝为 `HOST_CONFIG_INVALID`，信息给出行列，不“修复”；`hooks`、事件、组的形状不对也是 `HOST_CONFIG_INVALID`。两者都在写任何文件之前发现，什么都不改。长度为 0 的文件视同 `{}`；只有空白字符的文件不是 JSON，同样是 `HOST_CONFIG_INVALID`。
- `mwf-lifecycle` 自带一个小的 JSON 树（`src/json.rs`）：保留对象键的顺序、字符串与数字的原样写法；重新输出时沿用文件的缩进单位、换行（LF / CRLF）与末尾换行。**未改动的对象或数组按原文逐字节输出**（含其中的换行符，所以 CRLF 与 LF 混用的文件里未改动的部分保持原样；只在原文重新解析后与当前值完全相同时才用，改动不会被过期的原文掩盖），所以用户写成一行的数组保持一行；mwf 改过的容器按宿主的标准排版输出。
- 不启用 `serde_json` 的 `preserve_order`：Cargo 在 workspace 内统一 feature，启用后 `mwf-hooks` 用 `json!` 输出的键序会变，并多出 `indexmap` 依赖。

### 安全

- **符号链接边界**：基准目录本身可以是符号链接（`$HOME` 在 dotfiles 布局里常是链接，`CLAUDE_CONFIG_DIR` 由用户指定）；基准目录之下的每一段（`.claude`、`skills`、`mwf`、`settings.json` …）都用 `lstat` 检查，是符号链接（含悬空链接）或类型不对（该是目录的不是目录、该是文件的不是普通文件）时为 `WRONG_FILE_TYPE`，不写。所以 `~/.claude` 是指向 dotfiles 仓库的链接时 `install --host claude` 会拒绝；设置 `CLAUDE_CONFIG_DIR` 指向真实目录即可。
- **固定身份**：计划阶段读取每个文件时，同时记下文件与途经每一级目录（从基准目录起）的（设备号, inode）。写入与删除带着这份记录：文件或任何一级目录已不是计划时那个对象（即使内容相同，例如被同内容的文件或目录替换），或文件的权限已改变（例如从 0644 收紧到 0600，改写会把旧权限放回去）时为 `CHANGED`；计划时存在、现在消失的目录不会被重新创建。写入期间把途经的每一级目录**打开并持有句柄**，与 `mwf-store` 对 `.mwf/` 的做法相同（0048）；每次建文件、rename、unlink 之前（包括出错后的清理）核对每一级路径仍指向所持有的那个真实目录。某一级被换成符号链接为 `WRONG_FILE_TYPE`，被换成另一个目录或消失为 `CHANGED`，之后不再经由它建、改名或删除任何东西：这时临时文件（0600）留在原来的目录里，而不是经由被换掉的路径去删除。`uninstall` 删除变空的 skill 目录时同样先持有并核对途经的目录。
- **先计划后写入**：hooks 文件与两个 skill 文件全部读入、检查、算出新内容之后才开始写；任何拒绝都发生在第一次写入之前。写入顺序：`install` 先 skill 后 hooks（hooks 生效时 skill 已在），`uninstall` 先 hooks 后 skill。写到一半出 IO 错误时已写的文件保留，重新运行即可（每一步都幂等）。
- **原子写**：同目录临时文件（`.<名>.mwf-tmp-<pid>`，`create_new`，**创建时即为 0600**，写入任何字节之前）→ 写入 → 已有文件时改为**计划阶段从所读描述符取得的**权限（不从目标路径重新读取，被替换的目标的权限不会落到临时文件上）→ fsync → 核对目录链与目标（内容与 inode 都须与读到时相同，否则 `CHANGED`），并核对临时文件名仍指向 mwf 创建并打开的那个文件（否则 `CHANGED`，不发布）→ rename（新文件用 hard link，不会覆盖期间出现的文件）→ fsync 目录。rename 成功后不再碰临时文件名；hard link 之后或失败时，只有临时文件名仍指向 mwf 的文件才经由所持有的目录删除它。新建的宿主文件因此是 0600；已有文件保留原权限。
- **删除**：核对后先以 `create_new` 建出占位文件 `.<名>.mwf-del-<pid>` 并记下其（设备号, inode），且在整个删除过程中保持其描述符打开（打开的文件不会释放 inode，之后新建的文件不可能得到相同的身份），只有该名字仍指向这个占位文件时才把文件 rename 过去或在出错时删除它（被别人换掉的文件不会被覆盖或删除）；确认移走的仍是读到的那个文件（内容与 inode）才删除；否则把它放回原处（用 hard link，不覆盖期间出现的新文件）并报 `CHANGED`。所以备份之后、删除之前别人改的内容不会丢。
- **备份**：修改或删除一个已有文件、且可能丢失用户内容时，先复制到同目录的 `<文件名>.mwf-bak-<Unix 秒>`（重名加 `-1`、`-2` …；`create_new`，权限 0600）。备份永不覆盖、永不删除。不备份的情况：新建文件；内容与本版本 skill 完全相同的 skill 文件被删除；只含 mwf 条目的 hooks 文件被删除。`--json` 与文本输出给出备份路径。
- **skill 目录归 mwf**：`mwf` 这个 skill 名（0036）下的 `SKILL.md` 与 `references/commands.md` 由 mwf 管理。`install` 写入与本二进制不同的文件前先备份（用户改过的、或旧版本的）；`uninstall` 删除这两个文件（与本版本不同的先备份），再删除变空的 `references/` 与 `mwf/`；目录里有其他文件（含备份）时保留目录并在 notes 中说明。上一级目录（`skills/`、`.agents/`）不删。
- `--dry-run`：同样读取与检查（同样会报错），输出将要发生的改动，不写任何文件、不建目录、不做备份。

### hook 命令里的可执行路径（0037）

- 当前二进制的文件名必须是 `mwf`，否则 `install` 为 `INVALID_EXECUTABLE`，什么都不写：`uninstall` 与之后的 `install` 按文件名 `mwf` 认出条目，改名的二进制写下的条目将无法清理。`uninstall` 不受此限。
- 按 shell 的顺序查 `PATH`：在找到第一个 `mwf` 之前遇到相对目录（`.`、`bin`、空项即当前目录）时，hook 会因宿主运行它的目录不同而找到不同的 `mwf`，所以写当前二进制的路径并提示；第一个 `mwf` 之后的相对项无影响。第一个 `mwf` 与当前二进制 canonicalize 后相同时写 `mwf`。
- 否则写 `std::env::current_exe()` 给出的路径，不解析符号链接；需要时按 POSIX shell 单引号引起来（如含空格）。并在 notes 中说明（`PATH` 上没有 mwf，或第一个 mwf 是另一个二进制）。路径不是 UTF-8 时为 `IO`。

### 参数、输出与退出码

- `mwf install|uninstall --host claude|codex [--dry-run] [--json]`；`--host=<宿主>` 亦可；`--json` 与其他命令一样是全局的，也可写在命令之前（`mwf --json install …`，0050），bin 跳过它找命令。参数手工解析（0042：`mwf-lifecycle` 不依赖 `clap`），`-h` / `--help` 出现在任何位置都打印帮助到 stdout，退出 0。
- 用法错误退出 2，格式与 0050 相同：纯文本写 stderr `error: <原因>`、`Usage:` 行与 `--help` 提示；`--json` 时 stdout 一行 `{"ok":false,"error":{"code":"USAGE","message":…}}`。信息**从不复述参数的值**（本 crate 没有 secret 扫描器，0025），只说哪一类错误。
- `mwf --help`（clap）不列出 `install` / `uninstall`，与 `hook` 一样由 bin 在 clap 之前分发；它们各自有 `--help`，命令集合记录在 [cli.md](../cli.md) 与 skill 的命令速查中。
- 成功：纯文本第一行 `installed mwf for Claude Code` / `uninstalled mwf from Codex`（`--dry-run` 时 `would install … (dry run: nothing was written)`），然后 `hooks: <路径>: <状态>`、每个事件一行、`skill: <目录>`、每个文件一行、`hook command: <命令>`（只在 install）、`note: …`。由 `crates/mwf/tests/snapshots/lifecycle_*.snap` 固定。
- `--json` 成功：`{"ok":true,"data":{"action","host","dry_run","command"(仅 install),"hooks":{"path","status","backup","events":{<Event>:<状态>}},"skill":{"dir","files":[{"path","status","backup"}]},"notes":[…]}}`，键序如上。文件状态：`created` / `updated` / `unchanged` / `removed` / `absent`；事件状态：`added` / `updated` / `unchanged` / `removed` / `absent`。
- 失败退出 1：`INVALID_ENV`、`INVALID_EXECUTABLE`、`HOST_CONFIG_INVALID`、`WRONG_FILE_TYPE`、`CHANGED`、`IO`（见 [cli.md](../cli.md)）。纯文本 `error[CODE]: message` 写 stderr；`--json` 一行写 stdout。stdout 写不进去时退出 1。
- notes：`install --host codex` 在有事件为 `added` / `updated` 时提示在 `/hooks` 中信任 mwf 的 hooks（0024），`--dry-run` 时措辞为“真正安装后”再信任；没有改动时不提示（未改的条目仍受信任）；`install` 提示没有 `.mwf/` 的项目里 hooks 什么都不做；`uninstall` 说明项目的 `.mwf/` 未被触碰。

## 后果

- [cli.md](../cli.md) 记录参数与新增的错误码 `INVALID_ENV`、`INVALID_EXECUTABLE`、`HOST_CONFIG_INVALID`，`WRONG_FILE_TYPE` 与 `CHANGED` 也适用于宿主文件；[crates/adapters.md](../crates/adapters.md) 记录 `mwf_lifecycle::run` 的签名（与 `mwf-hooks` 同形，取代草案的 `install(host, opts)`）与依赖（`mwf-assets`、`serde_json`；白名单里的 `thiserror` 未用到）。
- 安装或更新后 Codex 用户须在 `/hooks` 中信任新的或改过的 hook；重复 `install` 不改动已信任的条目，也不再提示。
- `~/.claude` 或 `~/.codex` 是符号链接的用户需设置 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`；Codex 的 skill 位置不受影响。
