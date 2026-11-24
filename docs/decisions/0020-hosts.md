# 0020 首版支持的宿主：Claude Code 与 Codex

- 状态：已接受（2026-11-20）
- 注：“Pi 延后”已被 [0055](0055-hosts-pi-and-antigravity.md) 取代：新增宿主 `pi` 与 `antigravity`（别名 `agy`）。

## 决定

首版的 hooks 与 lifecycle（安装 hooks 与 skills）只支持 Claude Code 和 Codex。Pi 延后。

## 后果

新增宿主只需在 `mwf-hooks` 与 `mwf-lifecycle` 中各加一个适配模块，其他 crate 不变。
