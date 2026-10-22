# M0 基线审查与宿主可行性验证

> 历史记录：本文件记录 0.3.0 之前的验证结果，其中引用的文件名与路径（如 `src/storage.ts`、`src/setup.ts`、`src/pi-adapter.ts`、`src/protocol.ts`、`src/lifecycle/migrate.ts`、receipt v2）为 0.3.0 前的布局，0.3.0 已删除或替换。当前结构见 [架构](../architecture.md)。

> 历史阶段记录：随后所有者明确要求先迁入代码，再考虑改写。固定基线已迁入，见 [迁入记录](baseline-import.md)；本文当时“源码未迁入／不进入 M1”的状态不再代表当前迁移进度，GUI 未验收等实验边界仍有效。

初验：2026-10-13；续验：2026-10-16（§7）。项目起点：`c772349`。阶段状态：**blocked，已有部分运行证据；不进入 M1**。

本次完成固定基线审查、原测试及包验收、Pi 原生 CLI/RPC 实验、Codex 桌面附带运行时的隔离插件/hooks/MCP 实验。源码仍未迁入；0.2.0 未实现、未发布。桌面 GUI 本身未完成验收。

## 1. 来源与环境（10-13；版本变化见 §7）

- 固定上游：[zht7063/skills@7b8be0e59647c90227c0cb945b279d7fa7ab14ef](https://github.com/zht7063/skills/tree/7b8be0e59647c90227c0cb945b279d7fa7ab14ef/packages/mwf)。GitHub API 确认完整提交和 tree `db24488300157869a3dcca848c71a48df27588f2`，提交时间 `2026-09-16T11:14:07Z`。
- 系统：macOS 26.7，build 25G229，arm64。
- Node：26.8.2，终端及本次子进程路径 `/Users/iris/.local/share/node-v26.8.2-darwin-arm64/bin/node`。没有实测最低 Node 22.19.0，也未验证 GUI 环境解析路径。
- Pi：`@earendil-works/pi-coding-agent@1.1.0`，本机 `/opt/homebrew/bin/pi` 指向全局 npm 安装的 `dist/bundle/cli.js`。
- 桌面应用：本机 `/Applications/ChatGPT.app`，Info.plist 版本 `26.1007.30912`，build `20156`；附带 `codex-cli 0.162.0-alpha.17.2`。安装渠道未核实。
- 独立 Codex CLI：仅核对 `0.162.1` 版本，未运行同套兼容测试，不能继承附带运行时结论。
- 未使用知识图谱：本会话未提供 graph MCP 工具，回退源码读取与检索。

下载首次受沙箱网络限制失败；通过获准联网方式重试成功。该结果仅证明本次下载成功。

## 2. M0.1 基线审查

[文件、SHA-256、25 项测试名和直接依赖许可证清单](M0-baseline-inventory.json)覆盖 `packages/mwf` 与顶层 `scripts/install-mwf.ts` 共 41 个原始文件；归档本身的 SHA-256 也在该清单中。未把生成的 dist 或安装的 node_modules 当成原始源码。

固定归档中未找到 LICENSE/LICENCE/COPYING/NOTICE 文件，根目录及 MWF package.json 未声明许可证。没有为新仓库臆定 MIT，也未复制上游代码进入生产目录。用户已明确确认自己是两个仓库的所有者 @zht7063，并授权继续迁移；gh 核对登录账号及两个仓库 owner 均为 zht7063，admin 均为 true。[授权记录](M0-authorization.json)已补录。迁移授权缺口解除；公开发行许可证仍未选择，不影响本次授权迁移。

直接运行依赖：`@iarna/toml@2.2.5`（ISC）、`@modelcontextprotocol/sdk@1.30.0`（MIT）、`zod@3.25.76`（MIT）。这些声明不替代 MWF 本身的授权；全量发行包归属复核仍归 M6。

| 基线内容 | 迁移决定与影响面 |
| - | - |
| storage.ts | 保留 SQLite 跨进程锁、Transaction、原子替换、journal、恢复与路径保护；Core、setup 及存储回归均调用它，不能只移动文件而漏改导出与测试。新 handoff 后续复用同一事务。 |
| protocol.ts | 保留 schema 1 解析、记录渲染、状态和 glob；managed/AGENTS 历史逻辑迁往生命周期模块并保留迁移 fixture。M2 修复中文词项、tool 子串匹配及 Invalid when 被重复识别为 applicability 的问题。 |
| core.ts | 保留 execute 的输入验证、幂等 receipt、写锁与恢复顺序；initialize/diagnose/status 中的 AGENTS 依赖移出，bootstrap 全量 index/单一 handoff 改为新版有界读取与作用域交接。 |
| cli.ts / mcp.ts | 沿用薄入口；版本从 package metadata 获取，新增共用 API v2。旧 MCP 仅按参数 root 绑定，缺少独立宿主 cwd、enabled 与 generation 校验，不能直接作为新版自动接入入口。 |
| setup.ts | 拆分 init 与 attach、归属处理、适配器、detach；旧 receipt 保存整份 before 文本，detach 校验整文件 hash 后整份恢复，不满足新规范的片段归属和先停用再清理。 |
| pi-adapter.ts | 保留薄适配思想；移除编译模板内写死 root、单一 bootstrapped 标记及旧适配器安装流程。真实 Pi 1.1.0 的 trust/session/dynamic MCP 接口已单独核对。 |
| scripts/install-mwf.ts | 保留 tarball 安装、独立运行、空格参数和失败保留经验；去除默认从 skills checkout 构建与自动项目 setup 的耦合。 |
| tests / fixtures | 先迁三个测试文件及 contracts.ts、legacy schema 1 fixture；保留并发、kill、journal 冲突、幂等、symlink、每个 commit 边界恢复等 25 项基线测试；AGENTS/setup 行为测试按新版目标调整，不能直接删除。 |
| assets / adapters | 保留数据模板与历史 AGENTS fixture；旧激活规则不能作为新版正常安装资产，包内说明后续改成按需 setup/使用说明。 |
| 构建 / 包验收 | 沿用 TypeScript 5.9.3、NodeNext/ES2022、node:test、npm lockfile 与 bundleDependencies。check-package.ts 引用了仓库外层 installer，独立化时必须一并解除路径耦合。 |

实际运行均在临时解包目录，未改上游源码：

```bash
gh api repos/zht7063/skills/tarball/7b8be0e59647c90227c0cb945b279d7fa7ab14ef > /tmp/mwf-m0/baseline.tar.gz
mkdir -p /tmp/mwf-m0/upstream
tar -xzf /tmp/mwf-m0/baseline.tar.gz -C /tmp/mwf-m0/upstream --strip-components=1
cd /tmp/mwf-m0/upstream/packages/mwf
npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/mwf-m0/npm-cache
npm test
npm run test:package
```

- `npm ci`：exit 0，安装 99 个包。
- `npm test`：exit 0，包含 build/typecheck，25 pass、0 fail、0 skipped，约 5.77 秒。[日志](M0-baseline-tests.log)
- `npm run test:package`：exit 0，真实 tarball、空缓存离线安装、空 PATH、stdio handshake、读写/doctor、安装器 preview/retry/conflict 均通过。[日志](M0-baseline-package.log)
- 这是 **0.1 基线** 的结果，不是新版 G01/G02 或 L01 通过。旧 check-pi 手动调用内部 loader，不当成正常宿主安装发现证据，也未运行它替代新实验。

## 3. M0.2 Pi 1.1.0

[探针及运行命令](../../tests/integrations/m0/readme.md)通过正常 `pi install LOCAL_PACKAGE --local` 加载编译形态的 `.mjs` 扩展，然后由实际 Pi CLI/RPC 触发事件，未手动 import 内部 loader。

最终运行 exit 0，证据见 [M0-host-evidence.json](M0-host-evidence.json)：

| 场景 | 实际结果 |
| - | - |
| 包发现与 trust | `--approve` 加载扩展，真实 ctx.isProjectTrusted() 为 true；`--no-approve` 不加载项目包，不执行扩展及 MCP。 |
| 会话身份 | session_start 提供 cwd、getSessionId；普通轮次保持同一 ID，new_session 后 ID 改变。没有使用 getLeafId 充当稳定 session ID。 |
| 动态 MCP | registerMcpServer 后真实子进程启动，正常绑定 A；工具进入下一次请求。 |
| 注销 | unregister 后注册项消失，后续实际请求中工具 schema 消失。getAllTools 仍可能保留工具元数据，所以不能据其单独判断可调用性。 |
| reload / replacement | reload 再发现扩展；new_session 重建身份和注册。未覆盖 compact、fork、tree 的完整行为。 |
| 同名配置 | 用户级 mcp.json 覆盖动态注册；项目级同名条目再覆盖用户级。通过不同日志文件确认实际启动来源。尚未测替代内置 MCP 的第三方 Adapter。 |
| 复制项目 / 中文空格路径 | 从 B 正常启动、参数仍指向 A，MCP 实际 cwd 是 B，探针标记 ROOT_MISMATCH；没有通过配置 cwd 伪造来源。 |
| 快照与注入时序 | session_start 快照读取早于慢 MCP ready **10,025 ms**；before_agent_start 本身等待约 **10.005 s**。 |
| 正式输出通道 | before_agent_start 返回 message，before_provider_request 可观测标记；loopback 模型协议端点实际收到 `MWF_M0_MEMORY_V1`。 |

初版探针把读取放在 before_agent_start，5 秒断言失败（实测 10.009 s）。调整为 session_start 读取、before_agent_start 输出后，验证的是读取独立于 MCP；**不能宣称注入或模型调用也完全不等待 MCP**。该发现需保留在 M4 的适配与时序测试中。

## 4. M0.3 Codex 桌面附带运行时

实验运行的是桌面包内 CLI/app-server，不是 GUI 启动的真实用户会话。临时 CODEX_HOME 不包含已有凭据及插件，只有本次合成 marketplace 和 root manifest。

最终运行 exit 0，记录：

- 原生 marketplace add / plugin add 正常安装 root `plugin.json`，`extensions.com.openai.hooks` 被发现。
- app-server `hooks/list` 列出 SessionStart/UserPromptSubmit 两个 plugin 来源 hooks，均为 untrusted；普通执行没有 hook 输出，实际请求没有记忆标记。
- 单次执行已审查合成 hooks（官方 `--dangerously-bypass-hook-trust` 选项）后，两事件均运行，cwd 正确，session ID 一致，真实 loopback 请求包含标记。没有测试 GUI 持久信任，也没有将该选项写入产品安装流程。
- MCP 的配置不含 cwd；复制 A 为 B 后，真实启动 cwd 为 B，而参数仍绑定 A。即使没有 hook 运行也能识别不一致。
- 慢 MCP 初始化 10 秒时，请求在启动约 **1,062 ms** 后已经到达合成端点并含 hook 记忆；会话结束关闭尚未 ready 的 MCP。
- 独立零延迟场景通过 app-server `mcpServer/tool/call` 实际调用 status，返回 `allowed: true`、A 的 cwd 和 OK；不是仅观察注册声明。

中间一次测试误以为必须等到 mcp_ready 才能比较时序，因会话早已结束而没有该事件。最终探针改为检查实际请求时间早于故意延迟的 ready，并另开零延迟调用验证。另一次 JSON 字符串转义断言失败，实际 MCP 返回已成功；最终改为解析 content 中的 JSON 后比较。

## 5. 验收边界与阻塞

| 工作包 / 门槛 | 状态 | 尚缺内容 |
| - | - | - |
| M0.1 | verified | 技术清单、基线回归与所有者迁移授权已确认；公开发行许可证留待发布前确定。 |
| M0.2 | in_progress | Pi 最小路径通过；完整 branch/compact、替代 MCP Adapter、失败初始化仍需补测。 |
| M0.3 | in_progress | 附带运行时通过；GUI 正常安装、精确信任及重载流程、安装来源未验证。 |
| M0.4 | in_progress | 两运行时读取/请求与慢 MCP 的时序已有证据；GUI Node 路径未验证。 |
| M0.5 / L11 | in_progress | 独立 cwd 与合成 guard 已证明；10-16 已补 Codex + 真实 schema 1 数据及 v2 receipt 原型的 A/B 读写负例；Pi 真实数据路径和生产事务内复核尚未验证。 |
| M0.6 / G09 | in_progress | Pi 正式事件与本机协议端点、Codex 本机协议端点均可观测实际请求；完整产品的已提交记忆恢复与桌面 GUI 请求证据仍 not_run。 |
| M0.7 | in_progress | 本次代码、命令、输出和失败说明已保存；其余场景未发生，不预填通过。 |
| M1–M6 | not_started | M0 未 verified，不迁移核心源码。 |

L07/G05/G06/G07/G08 的部分可行性已有证据，但全部 44 项 **0.2.0 发布验收仍 not_run**。合成文件不具有生产存储事务、schema、启用状态或 generation 语义；没有正式 0.2.0 包可用于最终验收。

下一步：在隔离的真实桌面测试项目完成安装、信任、重载及 GUI Node 观测；补齐实际 `.mwf` 复制负例、Pi 未覆盖生命周期及 MCP 失败场景，再决定 M0 是否可以 verified。Linux 与最低 Node 版本单列，不从本机结果推导。

## 6. 官方契约依据

- [Pi v1.1.0 扩展契约](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md)、本机同版本 `dist/core/extensions/types.d.ts`：isProjectTrusted、getSessionId、register/unregisterMcpServer、before_agent_start、before_provider_request。
- [Pi v1.1.0 包发现](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/packages.md)、[MCP 配置](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md)、[信任](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/security.md)。Context7 用于定位；最终以本机 1.1.0 的文档/类型及运行证据为准。
- [OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)：root manifest 和 OpenAI 扩展路径；[Hooks](https://learn.chatgpt.com/docs/hooks)：信任、正式输出与 SessionStart/MCP 的时序。访问日期 2026-10-13。文档声明不替代真实 GUI 验证。

## 7. 2026-10-16 续验

所有者确认两个仓库均归其所有并授权继续迁移；GitHub 登录和两个仓库管理员身份已核对，见 [授权记录](M0-authorization.json)。这解决源码迁入授权，不代替公开发行许可证选择。

重新取回固定提交，41 个基线文件哈希全部吻合，隔离 npm ci/build 成功。机器上的 Pi 已升级 1.2.0，故在临时目录安装 **1.1.0** 复测；桌面附带 Codex 已变为 **0.163.0-alpha.10.2**，按新版本单独复测，不覆盖 10-13 证据。两套原探针均 exit 0；Pi 快照早于 MCP ready 10,070 ms、before_agent_start 等待 10.007 秒，Codex 请求在 MCP 启动后 1,063 ms 到达。详见 [续验证据](M0-followup-evidence.json)。

新增 binding-gateway / binding-probe，仅从临时目录导入固定上游 Core 和其 MCP SDK，不迁入产品代码。通过真实 app-server 工具调用验证：

1. A 中已提交 schema 1 记忆可读取，并可真实新增记录；从子目录启动时实际 cwd 保持子目录。
2. 完整复制 A 到 B，保留 A 的 root/generation 参数及启用状态；B 的 bootstrap/add 都返回 ROOT_MISMATCH，不泄露记忆，A/B 全部文件哈希不变。
3. A 内最近的未启用子项目阻断向父项目回退。
4. 已存在连接在 disabled 后拒绝读写；恢复 enabled 并换代次后旧连接返回 BINDING_STALE。
5. 启动即代次无效的进程，即使随后 receipt 恢复匹配，也不能复活。

共 7 项场景断言通过；每个拒绝场景均实际调用 bootstrap 和 add，并比较文件哈希。首次子目录实验没有 Git 项目边界，Codex 未发现父目录配置，报 unknown MCP server；补齐正常 Git fixture 后通过，没有将“未启动”计为安全拒绝。

边界：gateway 仅验证本机静态／顺序场景，未实现 runtime/API 完整契约、恶意 symlink 防护或事务内二次校验；不能据此宣称并发撤销安全或 L11 产品验收通过。真实数据实验当前仅覆盖 Codex，Pi 保持原合成实验范围。

桌面 GUI 工具明确返回 `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.`，未绕过此限制。GUI 正常安装、精确信任、重载和实际 Node 路径仍 blocked/not_run；附带 CLI/app-server 结果不能替代这些证据。M0 尚未 verified，M1 不启动。
