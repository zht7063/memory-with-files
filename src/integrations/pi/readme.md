# Pi Adapter

状态：已实现（`index.ts`，默认导出扩展；`package.json` 的 `pi.extensions` 直接指向 `dist/integrations/pi/index.js`）。

## 行为

- 导出 `PiAPI`/`PiContext` 接口与扩展函数；从自身模块定位 runtime，自动读取直接调用 Core，工具经会话级动态 MCP 注册／注销。
- 使用 shared 的 binding、identity 与 context 状态机：session_start / session_compact / session_tree 开新 epoch；before_agent_start 检测到会话或项目变化时重新绑定并在当次请求注入；session_shutdown 注销 MCP。可选 `PiContext.contextLimits` 收紧预算。
- 启用前用 `integrations/pi/conflicts.ts` 的 `piConflicts`（lifecycle 再导出） 检查同名 server；默认不写 `.pi/mcp.json`。

## 未验证

- 真实 Pi 宿主下的后续模型请求观测仍需 `tests/integrations/release/pi.py`（需 `MWF_PI_BINARY`）等实测证据。

## 依据

- 构建规范 §11；L02、L08、S06、G07–G10。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
