# 0.2.0 实施验收记录

> 历史记录：本文件记录 0.3.0 之前的验证结果，其中引用的文件名与路径（如 `src/storage.ts`、`src/setup.ts`、`src/pi-adapter.ts`、`src/protocol.ts`、`src/lifecycle/migrate.ts`、receipt v2）为 0.3.0 前的布局，0.3.0 已删除或替换。当前结构见 [架构](../architecture.md)。

本轮从已迁入源码实施，不重复搬迁。全部 44 项保留，正式发布门槛未降低。项目所有者已指定 MIT；LICENSE、package metadata、依赖许可清单已同步。**当前为开发候选产物，不具备正式发布资格。**

## 变更与影响

- M1：存储/协议/Core 归位，旧路径薄导出；普通 init/doctor 不依赖规则文件，首次 Git mode 必填；共用 API 2、错误与版本来源；Node 22.19.0。
- M2：持久 session 映射、session/task handoff、revision/hash 前置条件、事务内重放；中文及资格检索、事故边界、离线 tokenizer、双预算、code point cursor；epoch 锁内预留及输出状态。
- M3：receipt 2、真实 cwd 和最近 root、代次撤销、按归属编辑、两阶段 detach、保守旧版迁移；停用保留数据。
- M4/M5：实际 Pi npm 扩展与完整 runtime Codex 插件；本地直接读取、正式上下文输出、MCP 工具写、未知输出保留额度；Codex 截止时间 supervisor、同会话错误类别去重。
- M6：离线 package 测试、同 tarball 组装 zip、SHA256SUMS、文档与 MIT。不会运行 npm publish。

调用方、fixtures、测试 schema、模板、导出、安装器与构建脚本已同步。原 25 项基线测试在修改前复跑通过；原存储安全回归保留，旧规则文件/旧 setup 的行为断言改为 v2 生命周期与迁移测试。新增 v2/lifecycle 测试而非保留第二套业务实现。旧 readme 与 M0 记录仅作历史证据。

## 实际验证

命令/环境/当前产物 hash 汇总见 [机器证据](implementation-evidence.json)。自动测试、包验收、真实宿主分别记录，互不替代。

- npm test：32 项通过；之后新增的 tokenizer 参考测试在两套 Node 中单独通过（共 33 项）；含进程中断、每个提交边界恢复、幂等、外部修改、symlink、敏感数据、交接竞争、并发预算及 20 万 code point 中英/emoji 完整重组。
- 最低 Node 22.19.0：单独实际运行测试，结果见机器证据。
- test:package：离开 checkout、空缓存离线安装、无开发依赖/全局 MWF、根导入与 Pi 编译入口、CLI 读写/tokenizer、安装器；结果见机器证据。
- Pi 1.1.0：实际 tarball 正常安装发现，回环合成模型端点观察自动摘要、真实 add/handoff 工具写及后续请求，未信任/停用不注入，卸包重装用正式 package 命令。
- Codex 附带 CLI 0.163.0-alpha.10.2：实际 zip 正常插件安装，未信任不注入、临时测试信任后的真实请求包含已提交内容；app-server 实际 add/handoff 写，detach→attach 后存活旧连接仍被拒绝；复制项目不访问 A。此证据不代表桌面 GUI，也不代表独立发行 CLI。

发现并修复 Codex manifest 兼容问题：该版本遇到 `$schema` 不发现 hooks，去掉该可选字段后正常；保留 onboardingSkill。测试脚本不再修改受测 manifest。

## 44 项追踪

机器台账 [acceptance-0.2.0.json](acceptance-0.2.0.json) 保留原场景及通过条件。以下 pass 仅针对上述测试环境；partial 不计发布通过。测试名称和运行日志用于复核，不以代码存在代替证据。

| 编号 | 本轮状态 | 测试入口 |
| - | - | - |
| L01 | partial | tests/v2.test.ts |
| L02 | partial | tests/v2.test.ts |
| L03 | pass | tests/core.test.ts |
| L04 | pass | tests/core.test.ts |
| L05 | partial | tests/v2.test.ts |
| L06 | pass | tests/v2.test.ts |
| L07 | partial | tests/v2.test.ts |
| L08 | partial | tests/v2.test.ts |
| L09 | partial | tests/lifecycle.test.ts |
| L10 | pass | tests/lifecycle.test.ts |
| L11 | partial | tests/v2.test.ts, tests/integrations/release/codex.py, tests/integrations/release/pi.py |
| L12 | pass | tests/lifecycle.test.ts |
| S01 | pass | tests/v2.test.ts |
| S02 | pass | tests/v2.test.ts |
| S03 | partial | tests/v2.test.ts |
| S04 | pass | tests/v2.test.ts |
| S05 | pass | tests/v2.test.ts |
| S06 | partial | tests/v2.test.ts |
| S07 | pass | tests/v2.test.ts |
| S08 | pass | tests/v2.test.ts |
| S09 | pass | tests/v2.test.ts, tests/integrations/release/codex.py, tests/integrations/release/pi.py |
| S10 | pass | tests/v2.test.ts |
| S11 | partial | tests/v2.test.ts |
| R01 | partial | tests/v2.test.ts |
| R02 | pass | tests/v2.test.ts |
| R03 | pass | tests/v2.test.ts |
| R04 | pass | tests/v2.test.ts |
| R05 | pass | tests/v2.test.ts |
| R06 | pass | tests/v2.test.ts |
| R07 | pass | tests/v2.test.ts |
| R08 | pass | tests/v2.test.ts |
| R09 | pass | tests/v2.test.ts |
| R10 | pass | tests/v2.test.ts |
| R11 | pass | tests/v2.test.ts |
| G01 | pass | tests/core.test.ts |
| G02 | pass | tests/core.test.ts |
| G03 | pass | tests/core.test.ts |
| G04 | pass | tests/core.test.ts |
| G05 | partial | tests/core.test.ts, tests/integrations/release/codex.py, tests/integrations/release/pi.py |
| G06 | partial | tests/core.test.ts, tests/integrations/release/codex.py, tests/integrations/release/pi.py |
| G07 | partial | tests/core.test.ts |
| G08 | partial | tests/core.test.ts, tests/integrations/release/codex.py, tests/integrations/release/pi.py |
| G09 | partial | tests/core.test.ts, tests/integrations/release/codex.py, tests/integrations/release/pi.py |
| G10 | partial | tests/core.test.ts, tests/integrations/release/codex.py, tests/integrations/release/pi.py |

## 尚需关闭的事项

1. Codex 桌面 GUI、GUI Node、正常信任/重载和双宿主完整工作流；Linux/最低 Node 的实际包适用组合。按 [人工验收](desktop-checklist.md) 补证。历史 GUI 工具限制未被绕过。
2. Pi compact/tree/hot replacement 的全部真实宿主反例，Codex 产品 MCP 延迟/失败与卸载重装完整矩阵，以及 receipt 探测状态的完整宿主确认。CLI attach/rebind 已执行独立 Core/MCP 探测并校验 root、版本和 8 个工具；它不是宿主重载确认，不能当作 ready。
3. 完整三路性能报告。已有 [确定性输出比较](implementation-benchmark.json)，覆盖 10/100/1000 条与五类查询；只测记忆输出参考 token/bytes/读取耗时。任务正确性、错误注入、遗漏约束、收费 token、工具 schema/调用成本、端到端注入次数和耗时尚需固定真实任务集补测，不推导节省比例。
4. 依赖许可清单已生成，发布前仍需对最终产物中的原许可文件逐项归属复核。Tokenizer 已与 Python tiktoken 0.12.0 的 7 组独立 token ID 向量精确比对，见 tokenizer-reference.json。磁盘损坏/只读时错误提示无法保证持久去重；本地原子写入安全失败而非覆盖。

迁移风险：停旧进程是操作者前置条件；未知所有权/外部编辑会拒绝或 cleanup pending，必须保留备份与 receipt，不手工抹除 journal。GUI/Linux/完整性能证据未完成之前保持 RELEASE-STATUS.publishable=false。
