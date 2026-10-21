# CLI 与 stdio MCP

状态：**本目录为空，仅有本说明。** CLI 与 MCP 已实现，但位于 `src/cli.ts` 与 `src/mcp.ts`，尚未移入此目录。

## 实际入口

- `src/cli.ts`（npm bin `mwf` → `dist/cli.js`）：解析 `--flag value` 参数（`--input`/`--input-file` JSON、`--body-file`），记忆操作交 Core `execute`，attach/rebind/detach/setup 交 lifecycle。attach/rebind 必须带 `--harness pi|codex`，否则 INVALID_INPUT（退出码 2）；setup 默认 codex，`--harness pi,codex` 时依次以子进程运行每个 runtime 的 setup 并合并结果。attach/rebind/setup 先 `locateRuntime`；若定位到的已安装 runtime 不是当前进程，先运行其 `--version`，版本不符报 `RUNTIME_MISMATCH`，相符则转交该 runtime 执行（T02）。attach/rebind `--apply` 成功后做 direct（bootstrap）与 MCP 探测，并以 `persistProbe` 写入 receipt（`host_confirmed: unknown`）。stdout 只输出 JSON；失败退出码 1，异常 2。
- `src/mcp.ts`：`serve`（stdio MCP，`--profile agent|maintenance`，可带 harness/binding_generation/session_ref 并复核绑定）与 `probe`。默认 agent profile 工具：bootstrap、recall、get、add、propose、update、handoff、status。工具参数 `project_root` 可省略（默认绑定 root）；传入时不同路径、符号链接别名或含 `../` 均返回 ROOT_MISMATCH，即使最初经该符号链接绑定。

## 依据

- 构建规范 §8–9；L01、L07、S09、S11。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
