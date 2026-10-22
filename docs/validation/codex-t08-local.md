# T08 本地验证记录

> 历史记录：本文件记录 0.3.0 之前的验证结果，其中引用的文件名与路径（如 `src/storage.ts`、`src/setup.ts`、`src/pi-adapter.ts`、`src/protocol.ts`、`src/lifecycle/migrate.ts`、receipt v2）为 0.3.0 前的布局，0.3.0 已删除或替换。当前结构见 [架构](../architecture.md)。

日期：2026-10-21。范围：当前 T08 checkout；不是候选正式包或 Codex 桌面验收。

环境：Linux x64，Node 22.19.0（`/tmp/node-v22.19.0-linux-x64/bin/node`）。默认 `/usr/bin/node` 不支持 `--experimental-strip-types`，验证命令使用上述 Node 的 PATH。无实际 Codex 桌面、GUI Node、正常信任/重载或真实模型请求观测；桌面环境字段保留 null，不用本地系统或 Node 值代填。

| 检查                                                          | 结果    | 边界                                                                                                                                                    |
| ------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                           | pass    | 使用 Node 22.19.0，包含 build 与 tools/tests 类型检查                                                                                                   |
| `node --experimental-strip-types tests/codex-desktop.test.ts` | partial | 7 pass、0 fail、1 skip；skip 是 installed runner/MCP subprocess 矩阵                                                                                    |
| 五个标准的证据约束                                            | pass    | 必需场景缺失、CLI/bypass 升格、缺环境、内容版本不匹配均拒绝；仅验证证据结构，不验证证据真实性                                                           |
| in-process hook                                               | pass    | 手工构造此 checkout 的 Codex receipt；中文空格/子目录、V1→V2、compact/resume/clear、复制 root 拒绝、disabled/未 attach 初始化项目无输出、无规则文件写入 |
| installed runner/MCP 延迟及失败矩阵                           | not_run | sandbox 下 piped `spawnSync(node, ['--version'])` 返回 EPERM；测试明确 skip，不把 in-process 结果替代跨进程结果                                         |
| bundled Codex CLI/app-server release 脚本                     | not_run | 未提供真实 Codex binary，未运行安装/trust bypass 脚本；仅完成 Python 语法检查                                                                           |
| 实际桌面五项验收标准                                          | not_run | 详见 codex-desktop-t08.json；不升级 acceptance 总台账                                                                                                   |

runner 测试已实现但本轮未执行的断言：临时安装布局（不等于 GUI 正常发现）、10 秒延迟 MCP 尚未就绪时本地 runner 已恢复、MCP 启动失败时继续恢复、中文空格/子目录、复制绑定拒绝、更新 V2 后恢复、disabled 和未初始化项目无恢复成功、删除 runtime 后无法启动且 stdout 无恢复内容。

Prettier 对本次 TS/JSON/Markdown 文件执行 write/check。Python 文件只改证据汇总字段，通过 Python AST 语法检查；仓库未配置 Python Prettier parser。

未满足：全部真实桌面证据；正常宿主配置下的 hooks 禁用/未信任矩阵；宿主内故障注入与工具降级；复制项目 MCP 先启动及删除旧 runtime 的 GUI 行为；后续真实模型请求中的 V1/V2；sandbox 不允许执行的 runner/MCP 跨进程矩阵。整体 T08 为 partial，发布资格仍为 false。
