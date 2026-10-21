# 0.2.0 桌面人工验收

状态：**not_run，阻塞发布**。当前自动化工具不能操作 Codex 桌面 GUI；以下操作须由具有该能力的操作者执行，不能以本轮 CLI/app-server 结果代替。不要在真实工作项目做破坏性故障实验。

## 准备与证据

1. 保存 `releases/SHA256SUMS`、Node 绝对路径/版本、操作系统/架构、Pi 版本、Codex 桌面构建号、日期和测试人。
2. 建立两个包含中文和空格的临时项目 A/B、一个未启用子项目；保留 A 可用。使用正式 zip/tarball，经正常入口安装，不手工 import 扩展。
3. 记录每一步操作、截图或宿主日志、实际请求观测、工具输出及文件前后 hash。只保存合成数据，删除凭据和私人内容。每项标记 pass/fail/not_run，关联 L/S/R/G 编号和产物 hash。

## Codex 桌面完整流程

1. L02/L05/G08：正常安装插件，未启用项目发任务，不创建 `.mwf`，不自动加载记忆。记录安装入口及插件版本。
2. L03/L04：包内 setup 初始化 A（明确 Git mode），预览/应用 attach。已有 AGENTS/CLAUDE hash 不变；无规则文件项目不新增规则文件。
3. G06：不信任/禁用 hooks，记录不注入的真实请求；按 GUI 正常流程信任并重载，禁止用 CLI bypass flag 当证据。
4. G05/G09：提交唯一合成记忆版本 V1，新会话/真实任务看到 V1。人为延迟 MCP 10 秒、启动失败时分别观察 hook、本地读取、工具降级和模型请求时序。证明“直接读取不等待 MCP”，不得推导“整个宿主调用不等待”。
5. S01/S02/S11：并行两会话分别保存交接；用同 task revision 冲突写；退出 hook 后由永久 MCP 使用显式 session_ref 读写。随机/跨 root 引用失败。
6. S06/S07：更新 V2，compact/resume/clear 后下次必要请求包含 V2；摘要已经注入仍可 get 正文。会话结束本身不写正式记忆。
7. L06/L07/L11：从子目录启动；未启用子项目阻断父项目。复制 A→B（A 保持 enabled），让 B 的 MCP 先于 hook 启动，确认不能访问 A。再移动 A/删除旧插件目录，确认 stale 状态，不静默改配置。
8. L08–L12/S09/G10：双客户端启用；分别 detach 不影响另一个；无关 TOML 注释保留；修改 MWF 自有块后 detach 先 disabled 并报告 cleanup pending。重接后旧 MCP 仍被拒绝。卸载并重载无自动注入；重新安装/rebind 后原记忆与交接仍可读。
9. GUI Node：从桌面启动而非继承开发 shell，记录 hook 实际 Node 路径；PATH 缺 Node、旧 runtime、超时均短提示且任务可继续。同会话同类错误不重复（磁盘损坏/只读不能持久去重时另记）。

## Pi 补充流程

除已有真实脚本外，验证 compact、session_tree、session replacement、热 reload、项目切换。检查用户/项目同名 MCP 和旧 adapter 冲突；注销旧注册，不能留下旧 root 闭包。卸包、重载、重装后再次观察真实请求和工具列表。

## 完成与关闭

将脱敏记录放在 `docs/validation/`，更新 acceptance-0.2.0.json 的单项证据。Linux/最低 Node 适用组合另测，不能由 macOS 推导。全部 44 项及完整三路性能报告通过后才重新评估发布资格。此清单不授权自动 npm publish。

## T08 可执行矩阵与证据边界

T08 的逐场景桌面记录为 [codex-desktop-t08.json](codex-desktop-t08.json)。本轮无 Codex 桌面访问能力，所有桌面场景保持 `not_run`；本地检查另见 [codex-t08-local.md](codex-t08-local.md)。不要把本地 hook 返回内容视为模型已收到内容，也不要把 disabled integration 等同于 GUI 已禁用 hooks。

从仓库运行（Node ≥22.19）：

```sh
npm run typecheck
node --experimental-strip-types --test tests/codex-desktop.test.ts
node --experimental-strip-types scripts/check-codex-desktop.ts
```

检查器验证记录结构并汇总五个标准；有效的 `not_run` 记录退出码也是 0，必须读取输出状态。它不验证截图/日志的真实性，也不授予发布资格。无 piped subprocess 能力时，runner 矩阵明确 skip/not_run；可直接运行 `node --experimental-strip-types tests/codex-desktop.test.ts` 执行同一文件的 in-process 检查，但这不能补足 subprocess 或宿主证据。

| T08 标准           | 自动断言                                                                            | 必须由真实桌面补充的场景                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 环境记录           | 缺构建号、OS、GUI Node 路径/版本、安装/信任/重载方式或候选 SHA256 时不得 pass       | `desktop_environment`：从桌面启动，记录 hook 实际解析的 Node，不能借开发 shell PATH 推断                                                                                                                                       |
| 正常发现及信任     | CLI/local/bypass 证据不得升级桌面 pass；attach 的 reload 保持 pending               | `normal_install`、`normal_trust_reload`、`unenabled_project`：正常安装入口、hooks/MCP 发现日志、GUI 信任/重载、未启用项目无读取与文件副作用                                                                                    |
| 故障降级           | 独立 MCP 延迟 10 秒/启动失败时 runner 仍返回记忆；disabled binding 不返回恢复内容   | `mcp_delayed`、`mcp_failed`、`hooks_disabled`、`hooks_untrusted`：用可撤销的临时 MCP wrapper 注入故障；分别记录本地恢复时间、MCP 就绪/错误、工具降级、模型请求时间；GUI 禁用/未信任 hooks 时不报告恢复成功，规则文件 hash 不变 |
| 路径与失效 runtime | 安装目录和项目含中文空格、子目录启动、复制后拒绝读取 A、删除 runtime 后启动失败     | `copied_project`、`unicode_space_path`、`subdirectory`、`deleted_runtime`：A 保持 enabled，B 的 MCP 先启动；检查 root/argv 与不串读写；删除旧 runtime 后重载，确认诊断而非成功恢复                                             |
| 后续请求版本       | 本地 hook 的 V1→V2 及 compact/resume/clear；不同版本或无观测方式的请求记录不得 pass | `request_v1`、`request_v2_compact`、`request_v2_resume`、`request_v2_clear`：按宿主支持的请求观测方式检查实际出站请求中的合成内容版本，保存操作与请求的关联                                                                    |

每个桌面场景填 `status`、`source`、`artifacts`、`trust_bypass`。pass 必须是 `source: desktop`、`trust_bypass: false`、含可复核的脱敏证据路径，且环境字段齐全。请求场景还须填 `expected_version`、`observed_version`、`observation_method`，不能只保存助手自述“看到了 V2”。宿主没有支持的观测方式时保持 `partial`/`not_run`，不要用未经支持的抓取方式代替。

延迟测试只证明本地恢复没有依赖 MCP，不保证整个宿主任务调度不等待 MCP。`tests/integrations/release/codex.py` 仍是 bundled CLI/app-server 验证，完整脚本即使成功也汇总为 `partial`、桌面为 `not_run`；其中 trust bypass 仅用于合成 CLI 实验。
