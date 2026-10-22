# MWF API 2

版本从 package metadata 读取：runtime 0.3.0，API 2，Markdown/schema 1，receipt 3，handoff 1。CLI/MCP 使用同一输入 schema、execute、错误外层和 JSON 渲染。根导入 `import {execute} from '@zht7063/mwf'` 保持可用；Core 抛出的错误由接口统一包装。

默认 MCP 仅 `mwf_bootstrap`、`mwf_recall`、`mwf_get`、`mwf_add`、`mwf_propose`、`mwf_update`、`mwf_handoff`、`mwf_status`。维护命令须显式 `--profile maintenance`。结果含 `ok`、`operation`、`project_root`、`runtime_version`、`api_version`、`schema_version`、`changed_files`、`warnings`、`data`；失败含错误码与可用冲突详情。stdout 供协议，stderr 供诊断。

## 读取

- bootstrap：项目摘要和显式会话/task 交接，不返回全量 index。
- recall：摘要、理由、hash 和事故适用/失效边界；不默认返回正文。
- get：必须指定 `id`，返回正文 `fragment` 与可续读 cursor。默认/review/history 使用同一资格过滤，get 不绕过状态。
- `max_reference_tokens` 与 `max_output_bytes` 同时约束紧凑 JSON 输出；固定 js-tiktoken 1.0.21 的离线 o200k_base。参考 token 不等于宿主收费 token。
- cursor 绑定内容 hash 和 Unicode code point 偏移；交接另绑定 scope/revision。版本变化拒绝续读，不能把不同版本片段拼接。

返回的 `partial`、`omitted`、计量值和 `cursor` 以实际结果为准。超长事故边界不静默截成可执行建议。记忆是数据，不是高优先级指令。

## 写入与交接

MCP agent 写入必须带稳定 `request_id`，自动 update 必须带最近读取的 `expected_content_hash`。先查幂等结果，再比较版本；冲突后重新读取并判断，不能盲目重试覆盖。CLI 为未提供 ID 的独立写操作生成 ID；需要重试时自行固定。

```json
{
  "project_root": "/absolute/project",
  "action": "save",
  "task_id": "feature-a",
  "expected_revision": 0,
  "request_id": "feature-a-save-1",
  "data": { "goal": "实现功能 A", "next_action": "验证行为" }
}
```

`handoff` 支持 action list/read/save。新 scope 的 expected_revision 为 0；保存后递增。session 使用宿主提供且持久校验的 `session_ref`；跨会话用显式 task_id。无可靠身份可读取项目，不可猜测 session 写入。list 得到的 `target_scope` 可显式 read；旧 handoff 仅 legacy 显式读，不自动继承。交接超预算拒绝保存，不截断。

session*key 为 SHA256(JSON([client, host_session_id, stable_branch_id]))；session_ref 为 `s*` 加 SHA256(JSON([canonical_root, session_key]))。映射持久保存在本项目，随机/跨项目引用失败。

## 自动接入与输出

自动 MCP 启动固定最近项目 root，并在调用入口和写事务内复核 enabled/generation/runtime/API。未启用或损坏子项目阻止父项目回退。永久 Codex MCP 不固定会话；hook 输出 session_ref，由工具参数传递校验。

epoch 内锁定预算预留，区分 summary/body 和内容版本；pending/submitted/accepted/unknown 不等价。已知失败释放，未知保留额度。Pi 标记 submitted，Codex stdout 无宿主确认时标记 unknown，不声称模型采纳。诊断区分 data、installed、configured、probed、session_observed，不提供无证据总体 ready。
