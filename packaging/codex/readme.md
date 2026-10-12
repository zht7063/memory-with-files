# Codex 插件打包

状态：目录骨架；尚无功能实现。

M0 验证后维护 root plugin.json、hooks 配置及插件组装模板。

## 实现约束

- 不预先写入尚未在客户端验证的 manifest 或 hook 配置。
- 一个版本源生成 manifest；只维护 root plugin.json 与 extensions.com.openai 规范来源。
- 插件含 hooks/、skills/、runtime/package.json、runtime/dist/、runtime/assets/ 与完整运行依赖。
- runtime 从本次 npm 产物组装，不手工复制第二套 Core；manifest 不重复声明由项目配置启动的 MWF MCP。
- 插件携带 JS 不代表携带 Node，必须在 GUI 和终端分别验证 Node 路径。

## 实施与验收

- 阶段：M0 验证布局；M5 组装；M6 离线验收与发布。
- 依据：构建规范 §10.1、§15；L01–L02、G08–G10。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
