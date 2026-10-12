# Pi Adapter

状态：目录骨架；尚无功能实现。

原生扩展事件、/mwf 命令、会话级动态 MCP 注册与注销。

## 实现约束

- M0 以 Pi v1.1.0 的实际类型和运行实验验证，不直接照搬旧 pi-adapter.ts。
- 从自身模块定位同版本 runtime；使用真实 ctx 的 cwd、会话和信任状态。
- 直接 Core 恢复与 MCP ready 分离；正式 before_agent_start 输出渠道由 M0 确认。
- 会话树变化、压缩、替换、切项目和 reload 时重建上下文，不继续使用旧 ctx 闭包。
- 默认不写 .pi/mcp.json；检查用户级、项目级同名 server 及替代 MCP Adapter，不能覆盖或卸载共享资源。

## 实施与验收

- 阶段：M0 最小实验；M4 完整实现。
- 依据：构建规范 §11；L02、L08、S06、G07–G10。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
