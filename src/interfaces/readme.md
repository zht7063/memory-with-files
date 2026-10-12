# CLI 与 stdio MCP

状态：目录骨架；尚无功能实现。

参数／协议转换、共用 execute 分派和传输层结果输出。

## 实现约束

- CLI 与 MCP 调用同一套契约和用例；记忆操作进入 Core，安装／接入命令进入 lifecycle。
- 默认 MCP profile 仅暴露规范中的 8 个工具；维护 profile 必须显式选择。
- CLI stdout 仅机器 JSON、日志走 stderr；MCP stdout 仅协议消息。
- 自动 MCP 必须独立核对启动 root、enabled 和 binding_generation；绑定后工具参数不能换 root。
- 最终 npm bin 为 dist/cli.js；目前没有可执行入口，不创建返回成功的占位命令。

## 实施与验收

- 阶段：M1 迁移入口；M2 扩充工具；M3 接生命周期。
- 依据：构建规范 §8–9；协议一致性、退出码、真实 MCP 探测及 L01、L07、S09、S11。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
