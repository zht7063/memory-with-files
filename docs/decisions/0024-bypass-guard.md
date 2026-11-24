# 0024 防止 agent 绕过 mwf 直接改 `.mwf/`

- 状态：已接受（2026-11-20）；配合 [0016](0016-all-writes-through-mwf.md)
- 注：shell 检测也解包 `bash -c` / `sh -lc` 等的脚本与 Codex 的 argv，见 [0053](0053-smoke-test-follow-ups.md)。
- 注：pi 与 Antigravity 的工具名与路径字段，以及 Antigravity 的 PreToolUse 失败时拦截（放行须输出 `{"decision":"allow"}`），见 [0055](0055-hosts-pi-and-antigravity.md)。

## 已查证的事实（2026-11-20）

- **Claude Code**：PreToolUse hook 可拒绝工具调用。输出 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` 并退出 0（或退出 2，理由写 stderr）。文件类工具的目标路径在 `tool_input.file_path`。来源：code.claude.com/docs/en/hooks。
- **Codex**：同样支持 PreToolUse，拒绝格式与 Claude Code 相同（也接受旧格式 `{"decision":"block"}` 或退出 2）。`apply_patch` 以 `apply_patch` / `Edit` / `Write` 名称匹配，`tool_input.command` 是补丁文本，目标路径需从 `*** Add/Update/Delete File: <path>` 行解析；shell 命令以 `Bash` 匹配。非托管 hook 需用户在 `/hooks` 中信任后才运行。官方说明工具 hook 是"有用的护栏，不是完整的强制边界"。来源：Codex hooks 文档。

## 决定

- `mwf install` 为两个宿主都安装 PreToolUse hook（`mwf hook pre-tool --host …`）：
  - 文件编辑类工具（Claude：`Edit|Write|MultiEdit|NotebookEdit`；Codex：`apply_patch`）的目标路径落在项目 `.mwf/` 内 → 拒绝，理由中给出应改用的 `mwf` 命令。
  - shell 命令：只做尽力而为的检测（命令文本中出现 `.mwf/` 且含明显写操作，如重定向、`sed -i`、`rm`、`mv`、`cp`）→ 拒绝；`mwf …` 自身放行。
- skill 文本明确规定：`.mwf/` 只能通过 `mwf` 命令写。
- `mwf lint` 兜底，发现绕过造成的不合法状态。

## 后果

- 这是护栏而非安全边界：shell 检测必然有漏网之处，与 1.x 的 TTY 确认一样，防的是误操作，不是对抗性 agent。
- Codex 用户安装后需在 `/hooks` 中信任新 hook（`install` 输出里提示）。
