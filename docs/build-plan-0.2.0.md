# MWF 0.2.0 构建计划书

> 历史文档（0.2.0）：本计划书记录 0.2.0 的执行计划与验收编号，文中目录落点与文件名早于 0.3.0 分层重构。当前结构见 [架构](architecture.md)，0.3.0 变更见 [CHANGELOG](../CHANGELOG.md)。

## 1. 定位与当前状态

本计划把 [0.2.0 构建规范](MWF%200.2.0%20构建文档.md) 拆成可执行、可评审、有验收证据的工作包，供后续开发遵循。规范是目标行为的依据；本计划规定落地顺序，不替代或降低规范要求。若实验与规范假设冲突，先记录证据并修订兼容目标，不私自绕过约束。

当前基线为已迁入的 0.1.0，不再安排源码搬迁。实施顺序为 **M1 核心解耦 → M2 记忆与上下文 → M3 生命周期 → M4 Pi → M5 Codex → M6 发布验收**。保留全部 44 项验收与性能报告；M0 GUI 缺项不阻塞通用代码开发，但阻塞对应支持声明和正式发布。

本轮已实现 API v2、核心解耦、检索/交接/预算、生命周期、两宿主适配与打包；阶段状态仍为 in_progress，不能将局部测试通过写成完整阶段 verified。用户已指定 MIT，LICENSE 与包元数据已更新。实际命令、证据、未完成项见 [实施验收记录](validation/implementation-0.2.0.md)，历史 [迁入记录](validation/baseline-import.md)保留。
- 迁移来源：`zht7063/skills` 提交 `7b8be0e59647c90227c0cb945b279d7fa7ab14ef` 的 `packages/mwf`。
- 目标：单一源码包 `@zht7063/mwf`、一个 `package-lock.json`，不拆 monorepo。
- 运行环境：Node.js ≥ 22.19.0；首发实测系统为 macOS、Linux。
- Pi 首个验证基线为 v1.1.0；Codex 桌面构建号需在 M0 记录，Codex CLI 单独验收。
- 2026-10-13 已审查固定上游代码，25 项原测试及包验收通过；Pi 与 Codex 桌面附带运行时已有隔离实验。M0 当前 blocked，所有者迁移授权已确认，仍缺完整桌面 GUI 等证据，详见 [验证报告](validation/M0-validation.md)。

### 本次准备工作的完成范围

- [x] 建立规范 §3 中的源码、资源、打包、脚本与测试目录，记录职责及约束。
- [x] 建立阶段计划、架构说明和兼容性验证清单，更新项目与文档入口。
- [ ] M0 宿主兼容性验证（部分实验完成，阶段 blocked）。
- [ ] M1–M6 实现、迁移、打包和发布验收。

## 2. 范围与不可退让的约束

1. 从固定基线迁移而非重写；先保留 schema 1、锁、journal、幂等、恢复和路径保护的测试。
2. Core 无模型、无网络、无宿主 SDK；CLI/MCP/Adapter 共用契约、用例和渲染器。
3. 安装不等于启用。自动接入只认当前项目 `.mwf/local/integration.json` 中对应客户端的 enabled，并校验 root、信任和绑定代次。
4. 正常安装、初始化、升级、接入、停用不创建或修改 `AGENTS.md`、`CLAUDE.md`。仅迁移可精确删除有归属证据的旧块。
5. Markdown 是长期记忆真相来源；交接为 scoped JSON，复用事务。`.mwf/local/` 含持久状态，不可作为普通缓存整体清理。
6. 摘要优先、正文按需；计量最终模型可见输出；自动注入有单次与 epoch 累计预算。
7. detach 先停用后清理；清理冲突不丢数据；插件卸载、CLI 卸载、数据删除不是同一操作。
8. 真实宿主发现、恢复、写入、停用和后续模型请求证据不可用单元测试或本地 success 标记代替。

不进入本版：向量库、云端服务、daemon、后台 LLM 总结、跨项目自动记忆、跨 worktree 自动同步、管理界面、自更新管理器、复杂评分学习、规则文件静默回退。规范中可选的用户级项目索引及批量 detach 暂不列入关键路径；若以后实现，必须同时覆盖索引写入失败和不可访问项目，不作为第二套启用状态。

## 3. 仓库结构与开发落点

以下目录已建立；业务源码、插件模板、数据模板和测试随所属阶段引入，不预建空函数。每个落点的 `readme.md` 记录局部约束。

```text
.
├── readme.md
├── .gitignore
├── src/
│   ├── contracts/             # 共用输入输出、错误、版本与事件
│   ├── core/                  # 记录、交接与读取用例
│   ├── storage/               # 路径、锁、事务、恢复、幂等
│   ├── retrieval/             # 资格、匹配、排序、事故边界
│   ├── context/               # tokenizer、预算、分页、统一渲染
│   ├── interfaces/            # CLI / stdio MCP / 共用 execute
│   ├── integrations/
│   │   ├── shared/            # root、启用、session、epoch、诊断
│   │   ├── pi/                # Pi 原生扩展
│   │   └── codex/             # Codex hooks
│   └── lifecycle/             # init / attach / detach / rebind / migrate
├── assets/
│   ├── memory/                # schema 1 模板和 protocol
│   └── skills/                # 包内 setup 与工具使用说明
├── packaging/codex/           # 插件模板，M0 后引入
├── scripts/                   # 构建、包验收、发布检查
├── tests/                     # 回归、契约、集成与真实宿主证据约定
└── docs/                      # 规范、计划、架构及验证记录
```

根目录 package、lockfile 与 TypeScript 配置已迁入；M1 调整版本与解耦，M6 前补齐 `CHANGELOG.md` 和发行许可。不在审查许可前臆定新的许可证。构建生成 `dist/`，发布生成 `releases/`，均不提交。

依赖与数据设计见 [architecture.md](architecture.md)；脚本接口见 [scripts/readme.md](../scripts/readme.md)；测试组织见 [tests/readme.md](../tests/readme.md)。不提前锁死每个 `.ts` 文件名或函数签名，迁移时按原代码及实际用例决定最小拆分。

## 4. 实施顺序与阶段门槛

执行顺序基于已迁入源码：按 M1–M6 逐步实现，不重复搬迁；M0 宿主缺项独立跟踪。宿主验收和发布仍需要真实证据，代码搬迁本身不意味着 M0 或 M1 全部完成。

每阶段状态使用 `not_started / in_progress / blocked / verified`。测试结果使用 `pass / fail / not_run`；`not_run` 不等于通过。只有退出条件全部有证据才能标为 verified。计划不承诺未经工作量验证的完成日期。

### M0 — 兼容性与迁移可行性验证

**2026-10-16 状态：blocked。** 基线审查与回归、Pi 原生加载和 MCP、Codex 附带运行时的插件/hooks/MCP 已有证据；各工作包缺项见 [M0 报告 §5](validation/M0-validation.md#5-验收边界与阻塞)。10-16 已确认所有者授权、复测 Pi 1.1.0 与新版附带 Codex、补齐 Codex 真实数据复制及撤销原型；GUI 工具禁止操作该应用。以下复选框表示整个工作包完成，部分结果不提前勾选。

**前置：** 完整阅读目标规范；只在隔离目录／实验分支验证，不改业务项目接入。

- [x] M0.1 审查固定基线的 package、源码、测试、包验收脚本和许可证，列出迁入、拆分、移除项；不从浮动主分支取代码。
- [ ] M0.2 固定 Pi v1.1.0，核对官方类型与实际安装发现机制，验证事件、稳定会话身份、信任状态、正式上下文输出渠道和动态 MCP 注册／注销。
- [ ] M0.3 记录 Codex 桌面准确构建号、来源、系统与重载方式；验证 root manifest、hooks 信任、SessionStart/UserPromptSubmit 的实际输入输出和 session ID。
- [ ] M0.4 两个宿主都验证直接本地读取不等待 MCP ready；记录 Node 在终端与 GUI 下的实际解析路径。
- [ ] M0.5 验证 MCP 获得独立宿主启动 root。构造 A 仍启用且存在、复制到 B、B 的 MCP 先于 hook 启动的反例，证明不能访问 A；不通过强制 cwd 伪造验证。
- [ ] M0.6 验证宿主支持的模型输入观测手段，为 G09 确定证据来源；不能观察时明确发布阻塞项。
- [ ] M0.7 保存最小实验代码、命令、实际输出和负例，更新兼容矩阵；Codex CLI、旧 Pi 等单列，不推断支持。

**落点：** `docs/compatibility.md`；实验代码在实现时放入 `tests/integrations/`，脱敏证据随实际运行新增至 `docs/validation/`。不为尚未发生的实验创建成功记录。

**退出条件：** 两条目标宿主最小路径可运行，启动 root 与复制项目反例通过，输入输出和支持范围有证据。若某目标不成立，状态 blocked，先修订目标，不以 AGENTS 注入替代。

### M1 — 核心解耦与 API v2 基础

**前置：** 固定基线已在仓库；复跑现有测试及包验收，记录环境、提交和结果。M0 GUI 缺项不阻塞通用开发。

- [x] M1.1 复跑原有存储、解析、并发、中断恢复、幂等测试和 schema 1 fixture；保留基线测试对应关系，记录语义调整。
- [ ] M1.2 更新现有单包构建配置和依赖锁，设置 Node 下限；沿用原 TypeScript／测试方案，不为独立化更换工具链。runtime_version 唯一取自 package metadata。
- [ ] M1.3 把宿主安装、AGENTS 操作从 Core 移出；实现不依赖规则文件的数据 init、doctor、status。首次 init 显式 git-mode，重复执行不覆盖数据。
- [ ] M1.4 建立 contracts/API v2、共用 execute 与 CLI/MCP 结果外层，区分数据 schema、receipt 和 handoff 版本。
- [ ] M1.5 明确自动 MCP 与手动 CLI/MCP 的 root 校验入口；保留事务内复核的扩展位置，不在传输层复制存储逻辑。
- [ ] M1.6 迁移适用 memory 模板和独立包检查基础；建立真实可用的 typecheck/test/build 命令。

**交付：** 可构建的独立基础包、保真迁移测试、无宿主依赖的 Core、CLI/MCP 基础入口及许可证归属。

**退出条件：** schema 1 fixture 与存储回归通过；G01/G02 的基础部分通过；L03/L04 的 init/doctor 路径不改规则文件。只运行编译或空测试不算完成。

### M2 — 会话交接、检索与有界上下文

**前置：** M1 verified。

- [ ] M2.1 实现规范 §5.3 的会话哈希编码和持久映射；可靠身份缺失时只允许项目读取或显式 task，不选择“最新交接”。
- [ ] M2.2 实现 session/task scoped handoff、expected_revision 和稳定 request ID。先重放已完成提交，再判新提交冲突；原子比较与写入共用项目锁。
- [ ] M2.3 记录更新支持 expected_content_hash；自动 agent 更新要求版本条件。覆盖手工编辑后的冲突及重试。
- [ ] M2.4 实现 bootstrap/recall/get 和 handoff list/read/save；默认 list 最多 20 项稳定分页；legacy 仅显式读。
- [ ] M2.5 实现资格过滤、中文 bigram、tool/component 精确匹配、英文词边界、path 排除和互斥事故标题解析。
- [ ] M2.6 锁定离线 o200k_base 及词表；统一最终输出渲染、token/byte 双预算、partial、带版本 Unicode cursor 和最小输出错误。
- [ ] M2.7 shared 层实现 epoch、detail-aware 去重、锁内额度预留、pending/submitted/accepted/unknown；失败与未知输出分别处理。
- [ ] M2.8 默认 MCP 只暴露 8 个工具，维护 profile 显式启用；补齐输入大小、错误码、CLI/MCP 契约一致性测试。

**交付：** 有界读取、可并发交接、检索修复、离线 tokenizer、确定性基准数据。

**退出条件：** S01–S08、S10–S11、R01–R11 对应的确定性测试通过；涉及真实宿主的 S06/S08 在此验证契约，最终证据仍由 M4/M5 提供。20 万字符含 emoji 正文分页重组必须等于原文；并发 hook 不得超额。handoff 超限拒绝保存，不能截断后报成功。

### M3 — 生命周期、所有权与旧入口迁移

**前置：** M2 verified。

- [ ] M3.1 实现 attach/rebind 只读计划、对应插件 runtime 定位和委派；Node、API、root、generation 分别验证。全局 CLI 不冒充插件 runtime。
- [ ] M3.2 实现 receipt v2 与 JSON key/TOML 受管条目所有权；仅记录自有值，不备份整份共享配置或凭据。无法保留语法／注释时停止写入。
- [ ] M3.3 实现幂等绑定：无变化不换 generation；初次启用、重新启用、root/runtime 实际变化才换。root 变化先停用所有客户端，只启用指定客户端。
- [ ] M3.4 detach 默认预览，apply 后先 disabled 再清理；冲突保留资源与 receipt，支持继续清理；写事务内再次检查 enabled/generation。
- [ ] M3.5 migrate 默认预览；识别旧入口并要求先停止，AGENTS 块按 hash／严格 fixture 删除；冲突不启用新版，事务失败可恢复。
- [ ] M3.6 删除退役 bootstrap_version/bootstrap_hash/hooks_required 字段；保留长期记录、inbox、旧 handoff 原文；setup 仅保留带弃用提示的兼容调用。
- [ ] M3.7 status 区分 data/installed/configured/probed/session_observed；attach 部分成功报告 configured/degraded/pending，不宣称 ready。
- [ ] M3.8 覆盖 track/ignore、tracked Codex 配置警告、重复操作和停用后独立 CLI 可读；补写真实实现对应的迁移说明。

**交付：** 生命周期命令、配置所有权、可恢复迁移与 `docs/migration-0.2.0.md`。

**退出条件：** L03–L12、S09、G02–G04 的可自动化测试通过；配置无关字段与注释保留，旧连接不会在重新 attach 后复活。宿主专属端到端结果留待 M4/M5。

### M4 — Pi 完整工作流

**前置：** M3 verified，M0 的 Pi 契约仍与实测版本一致。

- [ ] M4.1 实现编译后的扩展入口、包声明、自身 runtime 定位和 `/mwf init|attach|status|detach`。
- [ ] M4.2 用真实 ctx 验证 root/session/trust，动态注册 MCP；恢复直接调用 Core，不把 register 返回当 ready。
- [ ] M4.3 处理会话树、compact、replacement、项目切换、reload/shutdown；注销自有连接，避免旧 ctx 和重复工具。
- [ ] M4.4 检查有效用户／项目同名 MCP 配置及替代 Adapter，报告来源；不卸载共享扩展或另起一套同名工具掩盖冲突。
- [ ] M4.5 从本次打包的 npm tarball 正常安装发现，完成自动读、工具写、恢复、detach、卸包／重载、重新接入；采集 G09 真实后续请求证据。

**交付：** Pi 扩展及安装路径、契约测试、实际包测试记录和兼容矩阵更新。

**退出条件：** Pi 相关 L/S/G 验收通过，特别是 G07–G10；不能以开发目录手工 import 替代包发现。真实宿主不可用时标 blocked/not_run。

### M5 — Codex 完整工作流

**前置：** M4 verified，M0 的 Codex 桌面构建能力已确认。

- [ ] M5.1 生成单源 root manifest、hooks 和包内 setup skill；从同次 npm 产物组装完整 runtime，不要求全局 MWF。
- [ ] M5.2 SessionStart 直接恢复，UserPromptSubmit 有界 recall；实现 5 秒读取截止时间、简短可见错误和会话级提示去重。（0.3.0 变更：截止时间上调为 hook 15 秒 / runner 14.5 秒，见 [CHANGELOG](../CHANGELOG.md)。）
- [ ] M5.3 attach 写自有 `.codex/config.toml` MCP 条目，不固定 cwd/session ID；启动时先用独立宿主 cwd 验证 root，再读记忆。
- [ ] M5.4 覆盖 MCP 未 ready、hooks 未信任、复制／移动项目、插件路径变化及升级 rebind；hook 只诊断，不暗改配置。
- [ ] M5.5 从本次插件包正常安装，验证包内 setup、自动读、工具写、resume/clear/compact、停用重载及重装恢复；记录 G09 模型输入证据。
- [ ] M5.6 只有单独验证后才声明 Codex CLI 支持；子代理身份未验证时不自动写主会话 handoff，不夸大 session_ref 的认证能力。

**交付：** 可安装 Codex 插件、hooks/MCP 契约及桌面真实工作流证据。

**退出条件：** Codex 相关 L/S/G 验收通过，特别是 L11、G05–G06、G08–G10；路径含空格／中文、MCP 先于 hook 的场景必须实测。

### M6 — 独立发布验收

**前置：** M1–M5 verified；所有发布必需项有证据。

- [ ] M6.1 干净环境执行安装依赖、typecheck、test、build、test:package、test:integrations、pack:release；记录准确命令与退出码。
- [ ] M6.2 离开 checkout、隔离 HOME/PATH、无全局 MWF、无开发依赖、离线运行 tarball 与插件；校验运行依赖及 tokenizer 词表完整。
- [ ] M6.3 一个 package 版本生成 npm tarball、Codex zip、Pi 扩展资产和 SHA256SUMS；校验清单与摘要，pack 不自动 publish。
- [ ] M6.4 补齐 install、migration、architecture、protocol、compatibility、CHANGELOG；README 每条用户命令在实际包执行后才宣称可用。
- [ ] M6.5 按规范 §16.5 用固定任务集比较无 MWF／0.1／0.2；记录正确性、误注入、遗漏、维护成本、token、次数、耗时。真实 token 不可得时单列参考计量，不承诺节省比例。
- [ ] M6.6 完成下面的验收追踪，至少一条真实 Pi 与一条真实 Codex 桌面路径均通过；首发目标 macOS/Linux 各记录实际验证组合，不暗示未测组合。
- [ ] M6.7 复核原代码与依赖许可、归属、包文件清单和已知限制，形成发布说明。远程提交、建仓、npm publish 另需明确授权。

**交付：** `zht7063-mwf-0.2.0.tgz`、`mwf-codex-0.2.0.zip`、`SHA256SUMS`、完整文档及验证记录。

**退出条件：** 规范 §17.1 全部满足；无以 skipped/not_run 冒充成功的项目。

## 5. 验收编号追踪

以下列出规范 §16 的全部 44 个验收编号。通过条件以原规范为准，此表只分配责任和证据，不缩减场景。当前全部 **not_run**。

| 编号 | 首次实施／最终验收阶段 | 必需证据 |
| - | - | - |
| L01 | M1 / M6 | 脱离 checkout 的 tarball Core/CLI/MCP 运行日志 |
| L02 | M4–M5 / M6 | 无全局 MWF 的包内 setup 实测 |
| L03、L04 | M1、M3 / M6 | 无规则文件场景与已有文件前后字节比较 |
| L05、L06、L07 | M2–M3 / M4–M6 | 未启用、嵌套 root、两项目和中文空格 argv 负例 |
| L08、L09、L10 | M3 / M4–M6 | 分客户端停用、共享配置差异、cleanup pending |
| L11 | M0、M3 / M5–M6 | 复制且原项目仍启用、MCP 先启动、移动及旧插件删除反例 |
| L12 | M1、M3 / M6 | 重复操作的配置／数据快照 |
| S01、S02、S03、S04、S05 | M2 / M6 | 会话／task／worktree 隔离、并发 revision、legacy 显式读 |
| S06、S07、S08 | M2 / M4–M6 | epoch、摘要与正文去重、内容变更和仅 session-end 不保存 |
| S09 | M3 / M4–M6 | 旧 MCP 在 detach→attach/rebind 后继续被拒绝 |
| S10、S11 | M2 / M4–M6 | 路径 ID、冲突保护、跨进程 session_ref 持久校验 |
| R01、R02 | M2 / M6 | 10/100/1000 条预算测量、20 万字符分页重组 |
| R03、R04、R05 | M2 / M6 | 状态资格、中文词项、英文标识反例 |
| R06、R07、R08、R09 | M2 / M6 | 事故标题、path 资格、长边界完整性 |
| R10、R11 | M2 / M4–M6 | 并发预算、未知输出预留、交接/list/legacy 有界分页 |
| G01 | M1–M2 / M6 | 原存储回归与新 handoff 的故障注入 |
| G02、G03、G04 | M1、M3 / M6 | schema 1 字节保真、AGENTS 归属反例、旧字段不复活 |
| G05、G06 | M0、M5 / M6 | Codex MCP 延迟／失败与 hooks 未信任的实际结果 |
| G07 | M0、M4 / M6 | Pi 有效配置冲突、reload/replacement 与真实 MCP root |
| G08、G09、G10 | M4–M5 / M6 | 正常包发现、真实后续模型请求、卸载重载再接入 |

规范 §16.5 的性能／收益报告另外验收，不能因没有 L/S/R/G 编号而跳过。

## 6. 开发与证据纪律

每个工作包开始前：阅读完整规范及所触及基线，列出调用方、测试、fixture、资源、配置与导出；检查数据丢失、越界读取和兼容破坏风险。存储搬迁与行为变化尽量分开评审。

每个工作包完成时：

1. 给非平凡新逻辑添加最小可重复测试；重要存储和配置路径包含失败／并发／恢复反例。
2. 执行已有相关检查，记录命令、环境、退出码和实际结果；未运行项说明原因，不仅写“已测试”。
3. 核对该工作包涉及的验收编号，更新实际状态和证据链接，不提前勾选后续阶段。
4. 更新行为变化涉及的文档入口；不加入顺手功能或未请求的依赖。

实际阶段报告在运行后新建 `docs/validation/M<N>-<topic>.md`，并加入文档索引，至少包含：

```text
阶段 / 工作包 / 状态：
规范章节及验收编号：
仓库 commit 或工作区标识、基线 commit、包版本及 SHA-256：
系统、Node、宿主版本、安装来源、信任与重载方式：
前置 fixture 与重现命令：
预期行为 / 实际结果 / 退出码：
证据路径（脱敏）与输出测量：
未运行项、失败项、风险及下一步：
```

真实宿主证据不得包含密钥、完整私人对话或整份其他 MCP 配置。G09 使用已知合成记忆和宿主允许的调试入口，明确区分 hook 输出、宿主接收和后续模型请求。

## 7. 当前风险与下一步

| 风险 | 处理与阻塞位置 |
| - | - |
| Codex 桌面 hooks／独立 MCP cwd 假设不成立 | M0 阻塞；修订支持范围，不用固定 cwd 或规则文件绕过 |
| Pi 事件、内置 MCP 或信任接口与规范基线不符 | 用固定版本官方类型和实际实验修正 Adapter；未验证版本不宣称支持 |
| MIT 已由所有者指定 | LICENSE 与包元数据已更新；最终捆绑依赖归属仍需核对 |
| TOML 编辑无法保留用户格式或注释 | M3 输出可审查计划并停止，不整体重序列化 |
| detach 后旧进程继续写入 | M3 每次调用及写事务复核代次，真实宿主验证旧连接 |
| tokenizer 或运行依赖遗漏 | M2 锁定离线资源，M6 用无开发依赖的真实包验收 |
| 无法观察真实后续模型请求 | G09 保持 not_run，阻止自动恢复验收声明 |

**当前进入 0.2.0 实施，保真迁入已完成。** 固定基线已落入本仓库；当前实现与证据见实施验收记录，继续关闭 44 项及性能报告缺口。M0 剩余 GUI/Pi 场景独立跟踪，不阻塞通用代码开发，也不因此标记通过。

## 8. 本次实施决策（2026-10-16）

沿用全部 44 项验收与性能报告。M0 剩余实验不阻塞 M1–M5 开发；Pi 与 Codex 桌面均通过才允许正式发布。先复跑基线，再按 M1–M6 顺序实施。历史报告不回写为新版成功。
