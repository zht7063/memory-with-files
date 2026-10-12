# Codex Adapter

状态：目录骨架；尚无功能实现。

command hook 输入输出、会话事件转换与插件内 runtime 定位。

## 实现约束

- M0 先实测目标桌面构建的插件发现、hook、独立 MCP cwd；桌面结果不等于 CLI 支持。
- SessionStart 直接通过 Core 恢复，不等待 MCP；UserPromptSubmit 有真实查询后有限 recall。
- 单次读取 hook 默认总截止时间 5 秒；失败允许任务继续，同会话同类错误仅短提示一次。
- 转换成宿主支持的 additionalContext；不把 CLI JSON 直接当 hook 输出。
- 不静默 rebind、不读取 transcript 生成记忆、不以 AGENTS 作为兼容回退。

## 实施与验收

- 阶段：M0 最小实验；M5 完整实现。
- 依据：构建规范 §10；L02、L07、L11、G05–G06、G08–G10。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
