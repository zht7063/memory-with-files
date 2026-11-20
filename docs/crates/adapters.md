# 适配器与其余 crate

> 状态：已接受为实现起点（[0044](../decisions/0044-implementation-and-branches.md)）；实现中可调整，调整须回写本文档。依赖白名单见 [0042](../decisions/0042-dependency-policy.md)。

## mwf-cli

**职责**：命令行参数解析、调用 `mwf-app`、渲染文本 / `--json`、退出码（0028）。stdin 限长读取（0033）。

```rust
pub fn run(args: Vec<OsString>, io: &mut Io) -> ExitCode;   // Io 封装 stdin/stdout/stderr，测试可替换
```

依赖：`mwf-app`、`clap`（derive）、`serde_json`。禁止：依赖 domain / store / search；业务逻辑。

## mwf-hooks

**职责**：`mwf hook <event> --host claude|codex`。解析宿主 JSON、调用 `mwf-app`、输出宿主格式的一行 JSON；随机 fence、清理、截断；内部计时预算；**任何错误都退出 0**（0030）。PreToolUse 守卫：Claude 读 `tool_input.file_path`，Codex 解析 `apply_patch` 文本中的 `*** Add/Update/Delete File:` 行，shell 命令尽力检测（0024）。

```rust
pub fn run(event: &str, host: Host, stdin: &mut dyn Read, stdout: &mut dyn Write) -> ExitCode; // 恒为 0
mod claude; mod codex; mod fence; mod guard;
```

依赖：`mwf-app`、`mwf-assets`（提醒文本）、`serde`、`serde_json`、`rand`（fence）。禁止：依赖 cli / lifecycle / domain / store / search。

## mwf-lifecycle

**职责**：`mwf install|uninstall --host claude|codex [--dry-run]`。编辑宿主的 `settings.json` / `hooks.json`（四个事件：SessionStart、UserPromptSubmit、Stop、PreToolUse），写入 skill 文件；备份、幂等、只删带 `mwf hook` 标记的条目、拒绝符号链接（0031、0037）。

```rust
pub fn install(host: Host, opts: &InstallOpts) -> Result<Report, LifecycleError>;
pub fn uninstall(host: Host, opts: &InstallOpts) -> Result<Report, LifecycleError>;
```

依赖：`mwf-assets`、`serde_json`、`thiserror`。禁止：依赖 app 及以下（不读写记忆数据）。

## mwf-assets

**职责**：纯数据：`mwf` skill（`SKILL.md`、`references/commands.md`）、hook 提示文本、`init` 生成的模板。用 `include_str!` 编入二进制。

依赖：无。

## mwf（bin）

**职责**：读取第一个参数分发：`hook` → mwf-hooks；`install`/`uninstall` → mwf-lifecycle；其余 → mwf-cli。自身无逻辑。端到端测试（`assert_cmd` + `insta` + `tempfile`）放在这个 crate 的 `tests/`。
