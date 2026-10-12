# 共用契约

状态：目录骨架；尚无功能实现。

输入／输出 schema、错误码、事件类型和 API 版本。

## 实现约束

- runtime_version 从未来迁入的 package metadata 读取；schema=1、api=2、receipt=2、handoff=1 分别管理。
- 验证 root、scope、request_id、expected_revision、expected_content_hash、输入大小及 cursor；CLI/MCP 不另立契约。
- 本目录不依赖 Core、存储或宿主 SDK。

## 实施与验收

- 阶段：M1 建立 API v2；M2 补齐交接和预算契约。
- 依据：构建规范 §2.2、§6、§8；测试验证 CLI/MCP 的同输入、同结果、同错误语义。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
