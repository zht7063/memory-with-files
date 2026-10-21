# Codex 插件打包

状态：包含插件 manifest 与 SessionStart/UserPromptSubmit hooks；release 打包脚本从同次 npm 产物组装 runtime。桌面正常发现、GUI Node、信任/重载和故障注入仍未实测。

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

T08 的逐场景桌面证据和操作步骤见 [桌面验收清单](../../docs/validation/desktop-checklist.md#t08-可执行矩阵与证据边界)。CLI trust bypass 不能代替 GUI 正常信任；未取得宿主证据的场景保持 not_run/partial。
