# 上下文计量与渲染

状态：已实现。`output.ts` 对 core 只有 `import type { Result }`，无运行时依赖（有意的跨层类型导入）。仅 `output.ts` 一个文件；会话 epoch／去重状态机不在这里，而在 `src/integrations/shared/context.ts`（T04）。

## 导出（`output.ts`）

- `measure`：离线 `js-tiktoken` o200k_base 计量 `reference_tokens` 与 UTF-8 bytes（不是模型计费 token）。tokenizer 懒加载（首次精确计量时才 `require`，之后复用）；`measure(text, "estimate")` / `estimateTokens` 是不加载 tokenizer 的字符数估算（偏保守），Codex hook 路径使用，预算中 `tokenizer_id` 为 `approx_chars_v1`。
- `recall-cache.ts`：长驻 MCP 进程内 30 秒窗口的 recall 结果缓存，key = 完整入参 + 记忆文件 stat 指纹，写入后自动失效。
- `limits`、`BudgetInput`：默认上限与 `max_reference_tokens` / `max_output_bytes` 输入。
- `encodeCursor` / `decodeCursor`：绑定内容 identity 的分页 cursor。
- `boundResult`：对最终序列化结果做双预算裁剪与分页；`serialize`：统一 JSON 序列化。

## 约束与依赖

- 依赖 `storage/`（MWFError），并对 `core/index.ts` 有仅类型导入（`Result`）；Core 运行时导入本目录。
- 本目录不判断宿主是否接收输出。

## 依据

- 构建规范 §6.3、§7.4–7.5、§8.1；R01–R02、R09–R11、S07。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
