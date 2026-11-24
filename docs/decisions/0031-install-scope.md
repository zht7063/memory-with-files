# 0031 安装到用户级

- 状态：已接受（2026-11-20）
- 注：`pi`（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`，扩展 `extensions/mwf/`）与 `antigravity`（插件目录 `~/.gemini/config/plugins/mwf/`）同样只装到用户级，见 [0055](0055-hosts-pi-and-antigravity.md)。

## 决定

`mwf install --host claude|codex` 安装到用户级配置：

- Claude Code：`~/.claude/settings.json`（hooks）、`~/.claude/skills/`（skills）；尊重 `CLAUDE_CONFIG_DIR`。
- Codex：`~/.codex/hooks.json`（hooks）及其 skills 位置；尊重 `CODEX_HOME`。

装一次所有项目可用；某个项目是否启用由 `mwf init` 决定（没有 `.mwf/` 时 hook 直接返回）。
