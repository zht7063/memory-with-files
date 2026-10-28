# Codex Adapter

状态：已实现 command hook。

## 文件

- `runner.ts`：hooks.json 调用的入口，派生 `worker.js` 子进程，14.5 秒未完成即终止（hook timeout 为 15 秒；慢主机上 o200k tokenizer 初始化可达约 3 秒，5 秒预算会超时），输出超过 64 KiB 也终止；启动失败、超时或读取失败时输出简短提示，任务继续。
- `worker.ts`：读取 hook 输入并调用 `handleHook`。
- `hook.ts`：`handleHook`，处理 `SessionStart`（source startup/resume/clear/compact 时开新 epoch）、`UserPromptSubmit`（有 prompt 时有界 recall），输出宿主 additionalContext；可选 `context_limits` 输入；以及 `Stop`（见下）。
- `stop.ts`：`stopReason`，生成 Stop 自检提示（A：5 种记录类型、7 类 scope 标签、`mwf_add`/`mwf_propose` 写入路径；B：实质进展判断与 `mwf_handoff` 保存步骤；两者都不适用则静默结束），附带有界的 `turn_id`、`transcript_path`、`last_assistant_message` 摘录（最多 1500 字符，控制字符被清除）。
- `notice.ts`：`failureNotice`，同会话同类错误只提示一次；`isStopEvent`，供 runner/worker 判断 Stop 失败时不输出提示。

## Stop 钩子

每个 agent 回合结束时触发一次。项目已启用 Codex 且绑定有效时，首次触发返回 `{"decision":"block","reason":<自检提示>}`，Codex 将 reason 作为续写提示交给同一会话，由 agent 做两项独立判断：(A) 本回合是否有值得长期保存的记忆，有则经 `mwf_add`/`mwf_propose` 写入（索引 `index.md` 由写入路径维护）；(B) 本回合是否有实质进展（文件被创建/修改/删除，如 apply_patch 等编辑工具调用或改动仓库的 shell 命令；构建/测试/提交等推进工作的命令；任务或计划项推进、完成或受阻，如 update_plan；产出交付物；改变方向的决定），是则先 `mwf_handoff action=read` 取当前 revision（NOT_FOUND 为 0），再以 `expected_revision` 保存（goal/completed/next_action/blockers/decisions，覆盖式更新、revision 加一，合并仍有效的旧条目；有明确 task_id 时按 task 保存，否则用本会话上下文提供的 session_ref，二者皆无则跳过）。纯聊天、问答、只读探索、澄清提问或仅保存记忆的回合不写 handoff。两者皆不适用则静默结束。判断由 agent 依据摘录与 transcript_path 完成；hook 不解析 transcript（其格式不稳定）。钩子本身不写任何记忆，不读取 recall、不占用 context 预算。

`stop_hook_active=true`（该回合已被 Stop 续写过）时直接放行，避免循环。项目未启用、绑定失效、输入非法、worker 崩溃/启动失败或 runner 14.5 秒超时，一律放行（输出 `{}`），不产生 systemMessage，以免每回合重复提示。输入超过 128 KiB（如超长 `last_assistant_message`）时 worker 无法解析事件类型，沿用既有读取失败提示。

打包的 `packaging/codex/hooks/hooks.json` 以 `node ${PLUGIN_ROOT}/runtime/dist/integrations/codex/runner.js` 注册三个事件（SessionStart、UserPromptSubmit、Stop），timeout 15 秒（0.3.0 起由 5 秒上调，见 CHANGELOG）。每条消息都会触发 UserPromptSubmit，因此在慢机器上每条消息最多可能等待约 15 秒；快机器不受影响。MCP 不由插件 manifest 声明，而由 `attach --harness codex` 写入项目 `.codex/config.toml`。

## 未验证

- Codex 桌面 GUI 的安装、hook 信任、GUI 下 Node 路径解析尚无证据；CLI 结果不等于桌面支持。

## 依据

- 构建规范 §10；L02、L07、L11、G05–G06、G08–G10。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
