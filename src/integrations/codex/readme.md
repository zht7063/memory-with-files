# Codex Adapter

状态：已实现 command hook。

## 文件

- `runner.ts`：hooks.json 调用的入口，派生 `worker.js` 子进程，4.5 秒未完成即终止（hook timeout 为 5 秒；hook 路径不加载 o200k tokenizer，改用字符数估算，见 `context/output.ts` 的 `estimateTokens`），输出超过 64 KiB 也终止；启动失败、超时或读取失败时输出简短提示，任务继续。
- `worker.ts`：读取 hook 输入并调用 `handleHook`。
- `hook.ts`：`handleHook`，处理 `SessionStart`（source startup/resume/clear/compact 时开新 epoch）与 `UserPromptSubmit`（有 prompt 时有界 recall），输出宿主 additionalContext；可选 `context_limits` 输入。
- `notice.ts`：`failureNotice`，同会话同类错误只提示一次。

打包的 `packaging/codex/hooks/hooks.json` 以 `node ${PLUGIN_ROOT}/runtime/dist/integrations/codex/runner.js` 注册两个事件，timeout 5 秒（0.3.0 曾临时上调为 15 秒，现已恢复，见 CHANGELOG）。每条消息都会触发 UserPromptSubmit；hook 路径不加载 tokenizer，慢主机上也应远低于该截止。MCP 不由插件 manifest 声明，而由 `attach --harness codex` 写入项目 `.codex/config.toml`。

## 未验证

- Codex 桌面 GUI 的安装、hook 信任、GUI 下 Node 路径解析尚无证据；CLI 结果不等于桌面支持。

## 依据

- 构建规范 §10；L02、L07、L11、G05–G06、G08–G10。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
