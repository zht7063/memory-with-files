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

**职责**：`mwf hook session-start|prompt|stop|pre-tool --host claude|codex|antigravity`（`agy` 是 `antigravity` 的别名；`pi` 按 0055 计划中；Claude / Codex 的 SessionStart、UserPromptSubmit、Stop、PreToolUse，其他宿主的对应事件见 [0055](../decisions/0055-hosts-pi-and-antigravity.md)）。解析宿主 JSON、调用 `mwf-app`、输出宿主格式的一行 JSON；随机 fence、清理、截断；内部计时预算；**任何错误都退出 0**（0030）。PreToolUse 守卫：Claude 读 `tool_input.file_path`，Codex 解析 `apply_patch` 文本中的 `*** Add/Update/Delete File:` 行，pi 读 `write` / `edit` 的 `tool_input.path`，Antigravity 读 `write_file` / `edit_file` 的 `toolCall.args.Path`；shell 命令（Antigravity 为 `run_command` 的 `CommandLine`）尽力检测，并解包 `bash -c` 等的脚本（0024、0053、0055）。细节见 [0051](../decisions/0051-hook-apis-and-session-state.md)。

```rust
pub struct Io<'a> { pub stdin: &'a mut dyn Read, pub stdout: &'a mut dyn Write, pub stderr: &'a mut dyn Write }
pub fn run(args: Vec<OsString>, io: &mut Io) -> ExitCode;   // args 是 `hook` 之后的参数；恒为 0
mod fence;  // 随机 nonce、清理控制与 bidi 字符、外壳先行的预算
mod guard;  // apply_patch 路径解析、shell 命令尽力检测
```

- 项目根：宿主 JSON 的 `cwd` 向上查找；`cwd` 缺失或不是绝对路径时，Claude / Codex 用进程目录，Antigravity 用 `workspacePaths[0]`（也须是绝对路径），再不行就输出“空”、stderr 一行（hook 进程的目录是插件目录，不是项目）。没有 `.mwf/` 时输出“空”。
- “空”输出：一般是 `{}`；Antigravity 的 pre-tool 是 `{"decision":"allow"}`，因为 agy 把 `{}` 与任何 hook 失败都当作拒绝（0055）。
- 预算：内部截止 3 s；stdin 上限 1 MiB；每次 `additionalContext` 最多 9800 字符，fence 与说明行的长度先从预算中扣除，数据按剩余预算截断后再包裹，包好后不再截断（闭 fence 不会被切掉）；P4 安装时写入宿主超时 10 s。hook 不取写锁。
- Stop：`stop_hook_active` 为 true（Antigravity：`executionNum > 0`）时 `{}`；否则 `App::stop_reminder(session_id, turn)`（Claude 与 pi `prompt_id`、Codex `turn_id`、Antigravity 无）。Claude 与 pi 输出 `hookSpecificOutput.additionalContext`，Codex 输出 `decision: "block"` + `reason`，Antigravity 输出 `decision: "continue"` + `reason`。
- pi 的输入与输出沿用 Claude 的 JSON 形状，由 pi 扩展（`mwf-assets` 的 `PI_EXTENSION_TS`）翻译；Antigravity 的注入用 `injectSteps[].systemMessage`，prompt 走 PreInvocation 且只在 `invocationNum == 0` 时 recall（0055）。
- SessionStart：`source` 为 `clear` / `compact` 时先 `reset_session`。UserPromptSubmit：跳过 `/mwf…` 命令行；注入 slug、标题、summary，不带 rev；按预算放入整页后只对放入的页调用 `App::mark_recalled`。
- 失败：未知事件 / 宿主、坏 JSON、超限：`{}`，stderr 一行；SessionStart / prompt 的 app 错误（含 `INVALID_CONFIG`）：一行 `systemMessage`，只含错误码；Stop / PreToolUse 出错：`{}`（守卫放行）。

依赖：`mwf-app`、`mwf-assets`（提醒文本）、`serde`、`serde_json`、`rand`（fence）。禁止：依赖 cli / lifecycle / domain / store / search。

## mwf-lifecycle

**职责**：`mwf install|uninstall --host claude|codex|antigravity [--dry-run] [--json]`（`agy` 为别名；`pi` 按 0055 计划中）。编辑 Claude / Codex 的 `settings.json` / `hooks.json`（四个事件：SessionStart、UserPromptSubmit、Stop、PreToolUse），写入 pi 的扩展文件与 Antigravity 的插件目录（0055），写入 `SKILL_FILES`；备份、原子写、幂等、只删 `mwf hook … --host <本宿主>` 条目、拒绝基准目录之下的符号链接（0031、0037）。Claude 与 Codex 在 P4 实现，细节见 [0052](../decisions/0052-install-and-uninstall.md)；Antigravity 已实现，pi 尚未实现，见 [0055](../decisions/0055-hosts-pi-and-antigravity.md)。

```rust
pub struct Io<'a> { pub stdin: &'a mut dyn Read, pub stdout: &'a mut dyn Write, pub stderr: &'a mut dyn Write }
pub fn run(args: Vec<OsString>, io: &mut Io) -> ExitCode;   // args 从 `install` / `uninstall` 起；退出码 0 / 1 / 2
mod hooks;  // 认出、加入、删除 mwf 的条目
mod json;   // 保留键序、原文与排版的 JSON 树（不启用 serde_json 的 preserve_order）
mod fsx;    // 不经符号链接的读（含文件与目录身份）；持有目录句柄的原子写、先移开再删、0600 备份
```

- 文件：Claude `$CLAUDE_CONFIG_DIR`（默认 `~/.claude`）的 `settings.json`、`skills/mwf/`；Codex `$CODEX_HOME`（默认 `~/.codex`）的 `hooks.json`；pi `$PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）的 `extensions/mwf/index.ts`；Antigravity `~/.gemini/config/plugins/mwf/` 的 `plugin.json` 与 `hooks.json`（PreToolUse matcher `write_file|edit_file|run_command`）。Codex、pi、Antigravity 共用 skill `~/.agents/skills/mwf/`：`uninstall` 在另一个共享宿主仍安装着时保留它（读不了另一个宿主的文件时也保留，0055）。
- pi 的扩展与 Antigravity 的插件目录归 mwf，按 skill 文件的规则管理（与本版本不同的先备份；0052）。
- 参数手工解析（不依赖 `clap`）；用法错误的格式同 `mwf-cli`，但不复述参数值。先读入并检查全部文件，再写。

依赖：`mwf-assets`、`serde_json`（`thiserror` 在白名单内，未用到）；开发依赖 `tempfile`。禁止：依赖 app 及以下（不读写记忆数据）、`clap`。

## mwf-assets

**职责**：纯数据：`mwf` skill（`SKILL.md`、`references/commands.md`）、hook 提示文本、`init` 成功后的下一步提示（P2 已有 `INIT_NEXT_STEPS_GIT` / `INIT_NEXT_STEPS_LOCAL`；`init` 写入 `.mwf/` 的文件由 `mwf-store` 持有，见 [0049](../decisions/0049-app-defaults.md)）。用 `include_str!` 编入二进制。

```rust
pub const SKILL_NAME: &str = "mwf";                  // skill 目录名，也是 SKILL.md 的 name:
pub const SKILL_MD: &str;                            // skill/SKILL.md
pub const SKILL_COMMANDS_MD: &str;                   // skill/references/commands.md
pub const SKILL_FILES: &[(&str, &str)];              // （相对 skill 目录的路径，内容），供 install 写入
pub const PI_EXTENSION_TS: &str;                     // templates/pi-extension.ts：pi 的桥接扩展，install 填入 mwf 的路径（0055）
```

skill 文本是英文（与 CLI 帮助、`init` 提示一致）。单元测试把 `references/commands.md` 与 [cli.md](../cli.md) 对照：两边的命令集合相同，用到的选项与错误码都在 cli.md 中，且不出现 1.x 的词汇（MCP 工具、斜杠命令、`[[slug]]`、inbox 等）；改 CLI 时须同步改 skill。hook 文本（P3）：`HOOK_SESSION_START_INTRO`、`HOOK_PROMPT_INTRO`（fence 前的说明行）、`HOOK_STOP_REMINDER`（Stop 提醒，按 0040 的摄入流程）、`HOOK_DENY_EDIT`、`HOOK_DENY_SHELL`（PreToolUse 拒绝理由），在 `templates/hook-*.txt`，各一行；单元测试检查其中提到的命令与选项都在 cli.md 中。

依赖：无。

## mwf（bin）

**职责**：读取第一个参数分发：`hook` → mwf-hooks；`install`/`uninstall` → mwf-lifecycle；其余 → mwf-cli。自身无逻辑。`hook` 的分发在 P3 加入，`install` / `uninstall` 在 P4 加入。端到端测试（`assert_cmd` + `insta` + `tempfile`）放在这个 crate 的 `tests/`，只经由编译出的二进制测试，不以 dev 依赖引入 workspace crate（`check-crate-graph.sh` 计入 dev 边）。
