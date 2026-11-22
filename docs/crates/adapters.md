# 适配器与其余 crate

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

## mwf-cli

**职责**：命令行参数解析、调用 `mwf-app`、渲染文本 / `--json`、退出码（0028）。stdin 限长读取（0033）。P2 已实现，输出格式、用法错误与 stdin 上限见 [0050](../decisions/0050-cli-output-and-usage-errors.md)。

```rust
pub struct Io<'a> { pub stdin: &'a mut dyn Read, pub stdout: &'a mut dyn Write, pub stderr: &'a mut dyn Write }
pub const STDIN_MAX_BYTES: u64 = 1024 * 1024;
pub fn run(args: Vec<OsString>, io: &mut Io) -> ExitCode;   // args[0] 是程序名；在当前目录运行
mod args;    // clap derive
mod render;  // 纯文本
```

依赖：`mwf-app`、`clap`（derive，精确固定为 `=4.6.3`：更新的 `clap_derive` 用 `syn` 3，见 0050）、`serde_json`。禁止：依赖 domain / store / search；业务逻辑。

## mwf-hooks

**职责**：`mwf hook session-start|prompt|stop|pre-tool --host claude|codex`（SessionStart、UserPromptSubmit、Stop、PreToolUse）。解析宿主 JSON、调用 `mwf-app`、输出宿主格式的一行 JSON；随机 fence、清理、截断；内部计时预算；**任何错误都退出 0**（0030）。PreToolUse 守卫：Claude 读 `tool_input.file_path`，Codex 解析 `apply_patch` 文本中的 `*** Add/Update/Delete File:` 行，shell 命令尽力检测（0024）。细节见 [0051](../decisions/0051-hook-apis-and-session-state.md)。

```rust
pub struct Io<'a> { pub stdin: &'a mut dyn Read, pub stdout: &'a mut dyn Write, pub stderr: &'a mut dyn Write }
pub fn run(args: Vec<OsString>, io: &mut Io) -> ExitCode;   // args 是 `hook` 之后的参数；恒为 0
mod claude; mod codex; mod fence; mod guard;
```

- 项目根：宿主 JSON 的 `cwd`（缺失或不是绝对路径时用进程目录）向上查找；没有 `.mwf/` 时输出 `{}`。
- 预算：内部截止 3 s；stdin 上限 1 MiB；每次 `additionalContext` 最多 9800 字符，fence 与说明行的长度先从预算中扣除，数据按剩余预算截断后再包裹，包好后不再截断（闭 fence 不会被切掉）；P4 安装时写入宿主超时 10 s。hook 不取写锁。
- Stop：`stop_hook_active` 为 true 时 `{}`；否则 `App::stop_reminder(session_id, turn)`（Claude `prompt_id`、Codex `turn_id`）。Claude 输出 `hookSpecificOutput.additionalContext`，Codex 输出 `decision: "block"` + `reason`。
- SessionStart：`source` 为 `clear` / `compact` 时先 `reset_session`。UserPromptSubmit：跳过 `/mwf…` 命令行；注入 slug、标题、summary，不带 rev；按预算放入整页后只对放入的页调用 `App::mark_recalled`。
- 失败：未知事件 / 宿主、坏 JSON、超限：`{}`，stderr 一行；SessionStart / prompt 的 app 错误（含 `INVALID_CONFIG`）：一行 `systemMessage`，只含错误码；Stop / PreToolUse 出错：`{}`（守卫放行）。

依赖：`mwf-app`、`mwf-assets`（提醒文本）、`serde`、`serde_json`、`rand`（fence）。禁止：依赖 cli / lifecycle / domain / store / search。

## mwf-lifecycle

**职责**：`mwf install|uninstall --host claude|codex [--dry-run]`。编辑宿主的 `settings.json` / `hooks.json`（四个事件：SessionStart、UserPromptSubmit、Stop、PreToolUse），写入 skill 文件；备份、幂等、只删带 `mwf hook` 标记的条目、拒绝符号链接（0031、0037）。

```rust
pub fn install(host: Host, opts: &InstallOpts) -> Result<Report, LifecycleError>;
pub fn uninstall(host: Host, opts: &InstallOpts) -> Result<Report, LifecycleError>;
```

依赖：`mwf-assets`、`serde_json`、`thiserror`。禁止：依赖 app 及以下（不读写记忆数据）。

## mwf-assets

**职责**：纯数据：`mwf` skill（`SKILL.md`、`references/commands.md`）、hook 提示文本、`init` 成功后的下一步提示（P2 已有 `INIT_NEXT_STEPS_GIT` / `INIT_NEXT_STEPS_LOCAL`；`init` 写入 `.mwf/` 的文件由 `mwf-store` 持有，见 [0049](../decisions/0049-app-defaults.md)）。用 `include_str!` 编入二进制。

```rust
pub const SKILL_NAME: &str = "mwf";                  // skill 目录名，也是 SKILL.md 的 name:
pub const SKILL_MD: &str;                            // skill/SKILL.md
pub const SKILL_COMMANDS_MD: &str;                   // skill/references/commands.md
pub const SKILL_FILES: &[(&str, &str)];              // （相对 skill 目录的路径，内容），供 install 写入
```

skill 文本是英文（与 CLI 帮助、`init` 提示一致）。单元测试把 `references/commands.md` 与 [cli.md](../cli.md) 对照：两边的命令集合相同，用到的选项与错误码都在 cli.md 中，且不出现 1.x 的词汇（MCP 工具、斜杠命令、`[[slug]]`、inbox 等）；改 CLI 时须同步改 skill。hook 提醒文本随 `mwf-hooks`（P3）加入。

依赖：无。

## mwf（bin）

**职责**：读取第一个参数分发：`hook` → mwf-hooks；`install`/`uninstall` → mwf-lifecycle；其余 → mwf-cli。自身无逻辑。P2 全部交给 mwf-cli，`hook` 与 `install` / `uninstall` 的分发随 P3 / P4 加入。端到端测试（`assert_cmd` + `insta` + `tempfile`）放在这个 crate 的 `tests/`，只经由编译出的二进制测试，不以 dev 依赖引入 workspace crate（`check-crate-graph.sh` 计入 dev 边）。
