# 0026 删除：移入 trash，有入链时拒绝

- 状态：已接受（2026-11-20）
- 注：文中 `[[slug]]` 链接语法已被 [0038](0038-markdown-links.md) 取代，改为 `[文字](slug.md)`。

## 决定

- `mwf delete <slug>` 把页面移到 `.mwf/trash/<slug>.<UTC 时间戳>.md`；`trash/` 不进 git。
- 仍有其他页面链接它时拒绝（`HAS_BACKLINKS`，列出入链页面）；加 `--unlink` 才删除，同时把那些 `[[slug]]` 改成纯文本。
- 不再有 1.x 的 "TTY + 预览 token" 两步确认。
- skill 规定：只有用户明确要求才删除，日常淘汰用 `archive`。

## 恢复

进 git 的项目靠 git 历史；`--local` 项目从 `trash/` 手动取回。
