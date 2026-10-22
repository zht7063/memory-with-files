# 包内操作说明

状态：已实现。随 npm 包发布，并由 `pack:release` 复制为 Codex 插件的 `skills/`。

## 文件

- `setup/SKILL.md`（`mwf-setup`）：显式 status → init（选择 track/ignore）→（0.1 项目或遗留资源：按错误提示先用 0.2.x 处理）→ 预览后 attach（Codex 传 `--plugin-root`）→ 升级后 rebind → detach 的步骤；要求使用本包 runtime，不使用未知全局 MWF。Codex manifest 的 onboardingSkill 指向它。
- `mwf/SKILL.md`：记忆工具的使用说明。

## 约束

- 不向业务项目复制激活规则，不解析聊天日志自动生成正式记忆。

## 依据

- 构建规范 §9.3、§10.1、§15；L02、L03、G08。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
