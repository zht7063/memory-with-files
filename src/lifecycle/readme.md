# 生命周期与配置所有权

状态：已实现 attach / rebind / detach、已弃用的 setup 兼容层与 0.1 迁移；位于 core 之上。

## 文件与导出

- `index.ts`：
  - `locateRuntime`（T02）：定位已安装 runtime。Pi 读项目 `.pi/settings.json` 与 `$PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）中的 packages；Codex 先看自身是否在插件 `runtime/` 内，否则扫描 `$CODEX_HOME/plugins/cache`（默认 `~/.codex`），每个插件优先取 `local` 版本目录，否则取语义化版本最高者。校验包名 `@zht7063/mwf`、Codex plugin.json 版本一致或 Pi 扩展存在。找不到或多于一个报 `PLUGIN_RUNTIME_REQUIRED`（需 `--plugin-root`）；版本不同报 `RUNTIME_MISMATCH`。
  - `lifecycle(op)`：attach/rebind/detach，默认预览，`--apply` 才写。attach/rebind 必须传 `--harness pi|codex`（否则 CLI 报 INVALID_INPUT，退出码 2），一次只接一个客户端；detach 可 `--harness all`。0.1 项目报 `UNSUPPORTED_LEGACY_INSTALL`；v2 receipt 在锁内先升级为 v3（单文件原子替换），若仍拥有 0.1 资源则报 `LEGACY_RESOURCE_PENDING` 且不写任何文件；Pi 同名 server 冲突报 `OWNERSHIP_CONFLICT`；root 变化先停用全部客户端；仅绑定变化时轮换 generation。Codex 在 `.codex/config.toml` 写受管 `[mcp_servers.mwf]` 块，若该文件被 Git 跟踪仅警告。
  - `persistProbe`：锁内校验 generation 后写入探测证据，变化时报 `BINDING_STALE`。
  - `setup`（弃用）：首次需 git_mode，再逐个 attach；CLI 默认 harness 为 codex，`--harness pi,codex` 时依次运行各 runtime 的 setup 并汇总；`detach`、`piConflicts`。

## 约束

- 数据初始化（Core `init`）与宿主启用分离；正常流程不写 AGENTS/CLAUDE。
- 分层：可依赖 core/storage/contracts；Core 不得反向依赖本目录（`tests/architecture.test.ts`）。
- 未实现／计划中：binding 与迁移的后续工作包（T06 起，对应构建计划 M3–M5 剩余项）（宿主重载后的确认已实现：attach 写入 `host_confirmed: unknown`，首次 hook／扩展启动／MCP 调用由 `integrations/shared/confirm.ts` 写入 `host_confirmation` 并置为 confirmed；每次 attach/rebind 重建客户端条目，确认随之清空）。

## 依据

- 构建规范 §9、§12–14；L03–L04、L08–L12、S09、G02–G04、G10。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
