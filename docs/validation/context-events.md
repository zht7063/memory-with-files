# T04 上下文事件预期

> 历史记录：本文件记录 0.3.0 之前的验证结果，其中引用的文件名与路径（如 `src/storage.ts`、`src/setup.ts`、`src/pi-adapter.ts`、`src/protocol.ts`、`src/lifecycle/migrate.ts`、receipt v2）为 0.3.0 前的布局，0.3.0 已删除或替换。当前结构见 [架构](../architecture.md)。

以下是自动化状态机与适配器测试的预期，不代表真实宿主请求已验收；真实请求观测仍属于 T07/T08。

| 宿主 | 事件 | 预期 |
| --- | --- | --- |
| Pi | session_start（含恢复、清空后宿主发出的启动事件） | 新 epoch，下次 agent 请求重新 bootstrap |
| Pi | session_compact / session_tree | 新 epoch，下次请求重新加载当前版本 |
| Pi | before_agent_start 检测到 session ID 或项目变化 | 重新绑定，在当前请求加载新会话上下文，不沿用旧闭包 |
| Pi | session_shutdown | 注销 MCP，清理进程内绑定 |
| Codex | SessionStart，source 为 startup/resume/clear/compact | 新 epoch，重新加载当前版本；打包 hook matcher 已包含这些来源 |
| Codex | 新 session ID 的 SessionStart | 独立会话与 epoch |
| Codex | UserPromptSubmit | 保留 epoch、去重和预算；恢复遗留 pending 为 unknown |

宿主若提供更严预算，Pi 适配器通过 `PiContext.contextLimits`、Codex hook 输入通过 `context_limits` 传入 `max_reference_tokens` / `max_output_bytes`。这些是可选适配器输入；未提供时沿用 MWF 默认上限，不能据此声称宿主已提供限制。

重新进入 `beginContext` 时，未完成的 pending 视为投递结果未知，转为 unknown 并保留额度和去重键。明确 failed 才释放；epoch 重建清空旧额度。空数据或预算裁剪后已无 entries/handoff 时不输出模板。

## Behavior change (T04)

When Pi switches project or session, the context is rebuilt and the bootstrap is injected in that same turn (previously it was rebuilt without injecting).
