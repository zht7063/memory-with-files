# 文档索引

本目录统一保存项目需要长期保留的文档，包括构建规范、设计与调研、迁移说明、兼容性验证和发布记录。

## 构建规范

- [MWF 0.2.0 构建文档](MWF%200.2.0%20构建文档.md)：从用户提供的同名文件原样归档，定义独立化、宿主适配、实施阶段与验收门槛。文中功能与命令属于目标规范，不表示已实现或发布。

## 开发执行入口

- [0.2.0 构建计划书](build-plan-0.2.0.md)：当前状态、目录落点、M0–M6 工作包、阶段门槛、全部 44 项验收编号追踪和证据格式。
- [架构与目录约束](architecture.md)：模块依赖、数据责任、恢复与写入路径、预算和分发设计。分层已由 `tests/architecture.test.ts` 部分强制；各目录实际实现见 `src/*/readme.md`。
- [兼容矩阵与 M0 验证清单](compatibility.md)：宿主／系统目标、最小实验、运行记录要求与支持声明规则；已有部分运行时实验，完整支持仍未验收。
- [测试组织与证据要求](../tests/readme.md)：测试落点、关键反例、包验收与真实宿主证据。
- [构建与验收脚本约定](../scripts/readme.md)：已迁入的构建脚本及后续目标命令。

阅读顺序：完整构建规范 → 构建计划 → 架构及相关目录说明 → M0 兼容验证。原规范优先；若实际实验不支持规范假设，记录证据并修订目标，不静默降低门槛。

## 已有验证记录

- [固定基线迁入记录](validation/baseline-import.md)：代码范围、两处路径调整、回归与包验收。
- [上游 0.1.0 README](upstream/MWF-0.1.0.md)：原样归档，历史 monorepo 路径在本仓库对应根目录。

- [M0 基线审查与宿主可行性验证](validation/M0-validation.md)：固定基线、迁移清单、许可证缺口、原测试/包验收、Pi 与 Codex 附带运行时实验、阻塞项。
- [基线文件与测试清单](validation/M0-baseline-inventory.json)：固定来源和 SHA-256。
- [宿主脱敏证据](validation/M0-host-evidence.json)：实际事件、请求观测、MCP 调用与探针校验值。
- [10-16 续验证据](validation/M0-followup-evidence.json)：固定版本复测、真实数据复制与撤销断言、GUI 限制。
- [迁移授权记录](validation/M0-authorization.json)：所有者确认和 GitHub 身份核对。
- [M0 可复跑探针](../tests/integrations/m0/readme.md)：运行前置、命令与覆盖边界。

## 0.2.0 实施文档

- [安装、升级与卸载](install.md)：实际 CLI 与包路径，桌面未验证边界。
- [迁移说明](migration-0.2.0.md)：预检、停旧入口、精确清理与失败恢复。
- [API 2 协议](protocol.md)：共享结果、8 个默认工具、身份、版本和预算。
- [实施验收记录](validation/implementation-0.2.0.md)：当前结果、44 项逐条追踪、剩余发布阻塞。
- [T04 上下文事件预期](validation/context-events.md)：Pi/Codex 事件与 epoch 行为的自动化测试预期，非真实宿主证据。
- [桌面人工验收](validation/desktop-checklist.md)：可复现操作与需要记录的证据。
- [T07 Pi 验证](validation/t07-pi.md)：真实宿主 `@earendil-works/pi-coding-agent` 1.3.0 的结果。
- [T08 本地验证](validation/codex-t08-local.md)：Codex 本地检查，非桌面验收。
- [T09 宿主会话验证](validation/t09-host-sessions.md)：单宿主停用、卸载、重装与恢复步骤；真实宿主项为 not_run。
- [T10 端到端验证](validation/t10-e2e.md)：CLI、MCP 与双绑定的自动化生命周期，不关闭真实宿主门槛。
- [三路确定性输出基准](validation/implementation-benchmark.json)：非完整端到端性能报告，不推导节省比例。
- [CHANGELOG](../CHANGELOG.md) · [MIT 许可证](../LICENSE)

## 主线实现进度

main 已合并 T01（Core 解耦、检索独立）、T02（runtime 定位与 attach 探测、RUNTIME_MISMATCH）、T03（status/doctor 真实诊断）、T04（上下文状态机）、T05（会话身份与 worktree 隔离）、T06（binding 迁移）、T07（Pi 验收）、T08（Codex 验收）、T09（单宿主停用/卸载/重装/恢复）、T10（端到端生命周期测试）。真实宿主请求观测与 GUI 验收仍未关闭。

## 维护约定

- 新增需要保留的文档放在 `docs/`，并在本索引中添加入口。
- 实施与验证记录区分目标、实际结果和未验证项，不将计划写成已支持能力。
- 后续按实际进度补充安装、迁移、架构、协议、兼容矩阵及发布说明，不预先创建空白占位文档。
