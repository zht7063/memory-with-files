# 测试组织与证据要求

状态：原存储测试保留并调整 0.2.0 语义；新增 v2、lifecycle 与真实 release 宿主脚本。`npm test` 执行确定性测试，`npm run test:package` 测试实际离线 tarball，`npm run test:integrations` 默认仅运行契约测试。设置 MWF_PI_BINARY / MWF_CODEX_BINARY 才调用 `integrations/release/` 的真实宿主测试；需先生成 releases。未运行宿主明确报告 not_run，不计通过。M0 探针保留历史用途。

## 当前测试文件

`npm test`（先 build + typecheck）运行 `tests/*.test.ts`，当前 78 个顶层测试、含子测试共 85 项（Node 22.19.0 实测）：

- 分层约束：`src/core/`、`src/contracts/` 不得依赖 integrations、lifecycle 或宿主 SDK，contracts 不得依赖 storage。
- `core.test.ts`：迁入的 schema 1 存储回归——init 幂等、严格 schema 与凭据拦截、幂等重放、并发 ID、journal 恢复、symlink 边界、旧版迁移与 golden fixture。
- `v2.test.ts`：交接隔离与恢复、分页与预算、检索、绑定拒绝复制项目／撤销代次、epoch 预留与去重（T04）、status/doctor 诊断（T03）、Codex 事件重建 epoch、真实 git worktree 隔离与损坏会话映射拒绝（T05）。
- `lifecycle.test.ts`：Codex TOML 所有权与 detach、Pi/Codex runtime 定位、全局 CLI 只转交已校验的插件 runtime、多 runtime 与 manifest 不一致拒绝（T02）。
- `mcp.test.ts`：真实 stdio 工具调用与 root 校验；Codex hook 退出后新 MCP 进程复用会话身份（T05）。
- `pi-adapter.test.ts`、`tokenizer.test.ts`、`architecture.test.ts`：Pi 扩展启用／信任／epoch／detach；o200k 参考计量（fixture `fixtures/o200k-reference.json`）；分层约束。
- `t06.test.ts`：binding 迁移后复制／移动 root、runtime 删除与损坏映射均失败关闭（T06）；`codex-desktop.test.ts`：T08 桌面证据 schema 与汇总（含 waived）；`release.test.ts`：纯 Node zip 往返与打包后 Codex 插件 manifest/runtime 完整性（T11）；`t09-lifecycle.test.ts`、`e2e.test.ts`：见下文。
- `contracts.ts`：共享测试辅助，不是独立测试文件。
- `integrations/release/pi.py`、`codex.py`：真实宿主脚本；`integrations/m0/`：历史探针。

下表子目录是目标落点，目前测试仍为上述平铺文件，未拆分子目录。

## 测试落点

随实际测试加入下列子目录，不预建空 fixture 或空测试：

| 路径            | 测试内容                                                                  | 阶段       |
| --------------- | ------------------------------------------------------------------------- | ---------- |
| `storage/`      | 跨进程锁、journal、中断恢复、外部编辑冲突、幂等、symlink 与路径越界       | M1–M2      |
| `core/`         | schema 1 保真、无规则文件 init/doctor、scoped handoff、revision/hash 冲突 | M1–M2      |
| `retrieval/`    | 状态模式、中文、tool/component、英文词边界、path 和事故标题               | M2         |
| `context/`      | 最终输出双预算、Unicode cursor、交接分页、超长事故边界                    | M2         |
| `contracts/`    | CLI/MCP 一致性、错误码、工具 profile、输入限制、退出码                    | M1–M3      |
| `lifecycle/`    | 所有权、detach 两阶段、generation、迁移、重复执行                         | M3         |
| `integrations/` | M0 最小实验、宿主契约、root/session/epoch、真实 Pi/Codex 路径             | M0、M4–M5  |
| `package/`      | 真实 tarball/插件、独立安装、离线依赖与资源清单                           | M1 起、M6  |
| `fixtures/`     | 固定基线 schema 1、历史规则块、共享配置、事件输入与合成记忆               | 随对应测试 |

目录名用于定位责任，不要求把原测试机械拆散；优先保留原来的可重复运行方式。fixture 不含凭据、私人会话或真实用户记忆。

## 必须覆盖的反例

- A/B 项目、嵌套未启用子项目、复制后 A 仍存在、不同 worktree、中文与空格路径。
- 两进程更新同一 task revision 只能一次成功；已成功 request ID 重试重放，不误报冲突。
- 随机或其他 root 的 session_ref 拒绝写入；无会话身份不选“最新 handoff”。
- detach→attach/rebind 后旧进程继续拒绝；写事务内能捕获检查入口之后发生的撤销。
- 共享 JSON/TOML 的无关字段／注释和用户修改保留；AGENTS 重复 marker、错误顺序、修改块及未知来源都不误删。
- 未知 schema、内部 symlink 越界、恢复时外部编辑不覆盖；新交接与旧记录同等事务保护。
- 10/100/1000 条中英文记录、20 万字符含 emoji 的单行正文、长事故边界、最大合法 handoff、超长 legacy 与大量 session list。
- 并发 hook 的剩余额度和 pending 去重原子生效；未知输出不能伪造 accepted 或重复释放预算。
- 普通工作流不创建规则文件，已有 AGENTS/CLAUDE 前后逐字节不变。

`t09-lifecycle.test.ts` 模拟单宿主停用、卸载、重装与恢复；`e2e.test.ts`（T10）用构建后的 `dist/cli.js` 与真实 MCP SDK 客户端跑 CLI、MCP 与双绑定的完整生命周期。两者都不是真实宿主证据。

## 分层验收

1. **确定性回归**：不需要模型，覆盖数据、算法、事务、契约和所有权。
2. **包验收**：从当前构建产物安装，离开 checkout，验证运行依赖、离线词表和编译入口。
3. **真实宿主**：通过正常插件／扩展发现，验证自动读、工具写、恢复、停用和重载。不能用手工 import 代替。
4. **后续模型请求**：G09 需要宿主支持的观测证据；hook JSON 和本地 success 标记都不足。
5. **收益基准**：按规范 §16.5 比较三条路径，真实 token 与 reference_tokens 分开，不预设节省百分比。

完整 L01–L12、S01–S11、R01–R11、G01–G10 阶段映射见 [构建计划 §5](../docs/build-plan-0.2.0.md)。通过条件以 [原规范 §16](../docs/MWF%200.2.0%20构建文档.md) 为准。

## 结果记录

每次执行记录环境、准确命令、退出码、产物 hash、验收编号和证据。缺少宿主为 not_run，不是 pass；桌面证据可标 `waived`（必填 waived_by、substitute、reason、evidence），但 waived 不计为 pass，所在验收项最多为 partial；实现阶段 verified 和发布门槛都不能跳过必需的真实证据。

实际运行后才创建 `docs/validation/` 中的阶段报告并更新文档索引；格式见构建计划 §6。本次 M0 的实际结果见 `docs/validation/M0-validation.md`；不预填尚未运行场景的成功记录。
