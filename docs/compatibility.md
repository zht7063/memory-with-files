# 兼容矩阵与 M0 验证清单（当前 0.3.0）

状态：**已有部分 M0 运行时实验，完整支持组合均未验收**。2026-10-13 与 10-16 证据见 [M0 报告](validation/M0-validation.md)。下表区分实验结果与支持承诺。依据见 [构建规范 §2、§10–11、§16–17](MWF%200.2.0%20构建文档.md)，0.2.0 阶段任务见历史[构建计划](build-plan-0.2.0.md)。

## 0.3.0 变更（未发布）

| 项目 | 0.3.0 | 说明 |
| - | - | - |
| Node.js | ≥22.19.0 | 与 0.2.0 相同 |
| receipt | v3 | 读取 v2 时内存升级；首个 `--apply` 写入 v3 后 0.2.x 无法读取，不可降级 |
| 0.1 安装 | 不支持 | `UNSUPPORTED_LEGACY_INSTALL`，不写文件；先用 0.2.x 迁移 |
| 0.1 遗留资源（`.pi/*`、`.agents/skills/*`） | 不再受管 | v2 receipt 仍拥有时报 `LEGACY_RESOURCE_PENDING`；先用 0.2.x detach |
| 发布判定 | [linux-cli-harness/1](release-criteria.md) | 标准已变更：Linux 命令行 Codex CLI 与 Pi harness 通过即可发布；不再要求真实宿主、桌面、macOS、性能报告 |
| Codex 桌面、macOS、性能、真实计费宿主 | 未验证 | 不属于发布门槛，亦不声称支持已验证 |

以下各节为历史记录，不随 0.3.0 改写。

## 1. 目标矩阵

| 宿主／环境 | 版本 | 系统 | 安装来源与重载方式 | 当前结果 | 发布定位 |
| - | - | - | - | - | - |
| Pi 原生扩展与内置 MCP | v1.1.0 | macOS 26.7 arm64 | 本机 npm 安装；隔离项目正常 install/RPC/reload | 最小实验 pass；完整验收 not_run | 首发目标 |
| Pi 原生扩展与内置 MCP | v1.1.0 | Linux | 待记录 | not_run | 首发目标 |
| Codex 桌面本地 command-hook 插件 | ChatGPT.app 26.1007.30912 / 20156 | macOS 26.7 arm64 | 安装渠道、GUI 信任与重载待核实 | GUI not_run | 首发目标 |
| 上述桌面附带 CLI/app-server（隔离实验） | 0.162.0-alpha.17.2 | macOS 26.7 arm64 | 包内二进制；临时 marketplace/新进程 | 最小实验 pass；不代表 GUI 通过 | M0 可行性证据 |
| 桌面附带 CLI/app-server（10-16 续验） | 0.163.0-alpha.10.2 | macOS arm64 | 隔离临时 marketplace/app-server | 最小实验及真实数据复制原型 pass；GUI blocked | M0 可行性证据 |
| Codex 桌面本地 command-hook 插件 | 待确认可用构建 | Linux | 待确认客户端可用性 | not_run | 需 M0 明确，不能假定可安装 |
| 独立 CLI / stdio MCP | MWF 0.3.0（未发布候选） | macOS、Linux | `zht7063-mwf-0.3.0.tgz`（`npm run pack:release` 生成） | Linux：rain-tester 回归 measured；macOS：not_run | 首发目标 |
| Codex CLI | 本机 0.162.1 | macOS | 仅读取版本 | not_run | 单独验收，不继承桌面结论 |
| 旧 Pi、OMP、其他客户端、Windows | 未选定 | 未验证 | 未验证 | not_run | 不默认支持 |
| 纯网页／云端编排 | 未选定 | 未验证 | 不适用本地插件假设 | not_run | 不承诺本地 hooks |

Node.js ≥22.19.0 是目标运行要求；本次仅使用 Node 26.8.2，最低版本尚未验证。GUI 与终端分别记录实际 Node 绝对路径。Linux 的目标验证组合由 M0 根据实际宿主可用性明确；至少需要一条真实 Pi 与一条真实 Codex 桌面工作流，不得据此推导所有宿主／系统组合通过。

## 2. M0 实验清单

| 实验 | 需要保存的证据 | 阻塞条件 |
| - | - | - |
| 固定迁移基线 | commit、包与测试清单、许可证／归属、可沿用工具链 | 无法确认源码来源或许可 |
| Pi 正常包发现 | 安装步骤、包布局、加载／重载记录 | 只能手工 import，正常安装不发现 |
| Pi 生命周期与身份 | 事件输入、稳定 session/branch 来源、cwd/trust 及输出通道 | 无法可靠确定所承诺的身份或信任状态 |
| Pi 动态 MCP | 注册、注销、ready 探测、冲突来源、reload/replacement 结果 | 同名配置覆盖被误报为成功，或残留旧 root |
| Codex 插件发现与 hooks | root manifest、客户端构建号、信任设置、实际事件输入／输出 | 目标构建不支持或未信任仍被报恢复成功 |
| 独立启动 root | MCP 启动 cwd 来源、最近项目解析、固定 root 比较 | 只依赖静态 --root/generation 或人为固定 cwd |
| 复制项目负例 | A 仍存在并 enabled，复制到 B，MCP 先于 hook 启动 | B 能读写 A 的记忆 |
| 本地直接恢复 | MCP 延迟／失败时读取结果和耗时 | 启动恢复必须等待 MCP |
| 中文／空格路径 | Node 与 runtime argv、子目录启动结果 | 路径被 shell 拆分、root 串读 |
| G09 观测可行性 | 宿主调试入口、合成记忆在后续模型请求中的定位方法 | 只能看到 hook JSON 或本地 success 标记 |

最小实验通过只证明路径可行，不等于 M4/M5 的完整宿主支持。新增实验代码与证据时应在文档索引登记，不能把计划表勾选当运行日志。

## 3. 一条可审核的运行记录

每次验证至少记录：

- 宿主准确版本／构建号、系统及架构、Node 版本与绝对路径。
- 插件／包版本、SHA-256、安装来源和正常发现方式；源码 commit 或工作区标识。
- 项目信任、hooks 开关、有效 MCP 配置来源和重载动作。
- 合成 fixture、准确命令或操作步骤、预期／实际行为、退出码。
- 对应 L/S/R/G 编号、日志／截图／脱敏请求片段的证据路径。
- 尚未运行的场景、失败原因和支持限制。

诊断不得保存密钥、完整用户 prompt 或其他 MCP 的整份配置。G09 必须是后续模型请求证据；“已输出”“已接收”“agent 实际保存”分别记录。

## 4. 结果更新规则

- `pass`：指定组合的指定场景有实际证据；不是对其他组合的承诺。
- `fail`：已运行但不满足通过条件，必须保留反例。
- `not_run`：未运行，包括环境不具备；不得当作测试通过。
- 阶段被环境或能力阻塞时标 `blocked`，不采用规则文件注入回退。
- 0.3.0 起发布前，[发布判定标准](release-criteria.md) 中的 Linux CLI harness 项不得为 not_run 或 fail；其他宿主维持“未验证／不声明支持”。

## 2026-10-16 0.2.0 实施验证（不覆盖历史报告）

| 组合 | 已实测 | 尚未证明 |
| - | - | - |
| macOS arm64 / Node 26 | Core、事务回归、真实离线包、中文空格路径 | 不推导其他系统 |
| macOS arm64 / Node 22.19.0 | 同一源码自动测试 | GUI PATH、Linux |
| Pi 1.1.0 / 本地合成模型端点 | 正常 package 安装发现、自动读、实际 MCP 写、后续请求、未信任/停用 | 完整 compact/tree/hot replacement，见实施台账 |
| Codex CLI 0.163.0-alpha.10.2 | 正常插件安装、hooks、实际 app-server MCP 写、后续请求、复制项目、旧连接撤销 | 独立分发 CLI 及完整故障矩阵 |
| Codex 桌面 GUI | not_run | 安装、信任、重载、Node 路径、全部 GUI 工作流 |
| Linux / Node 22.19.0 | not_run | 全部适用组合 |

Codex 本次实测发现：官方示例的根 `$schema` 字段在上述运行时导致 hooks/list 为空；同一产物移除该可选字段后正常。仅去掉 onboardingSkill 无效，保留 onboardingSkill、去掉 `$schema` 有效。当前 manifest 省略 `$schema`，仍提供包内 setup skill，不降低 hooks 功能范围。此结论仅针对实测版本。

真实测试使用隔离 home 和回环合成模型端点，不计收费 token，不冒充真人 GUI 信任。附带 CLI 成功不能标记桌面已支持。后续发布按 [实施验收记录](validation/implementation-0.2.0.md) 补证。
