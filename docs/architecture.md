# MWF 0.3.0 架构与目录约束

状态：0.3.0 已按本文分层重构（未发布）。行为依据为 [构建规范](MWF%200.2.0%20构建文档.md)；0.2.0 落地顺序见历史[构建计划](build-plan-0.2.0.md)。

## 1. 一个源码包，多个薄入口

保留单包和一个 lockfile，不将 Core、CLI、MCP 分别发布。Module（模块）以职责而非预设文件数拆分；Interface（接口）同时包含输入输出、校验、不变量、失败语义和预算，不只是 TypeScript 类型。

```text
CLI / stdio MCP ── 共用契约与 execute ── Core ── storage
                                       ├───── retrieval
                                       └───── context
Pi / Codex Adapter ── shared ────────── Core
生命周期命令 ── lifecycle ──────────── Core / 所有权处理
```

- `contracts` 是共用叶子依赖，不反向导入业务实现。
- `storage` 负责文件与事务机制；`retrieval` 负责资格与排序；`context` 负责计量与唯一渲染。这些模块不读取宿主配置。
- Core 不导入 interfaces、integrations、lifecycle 或宿主 SDK，不调用网络和模型。
- Adapter（适配器）仅处理宿主身份、事件和输出通道；shared 封装 root、session、epoch、去重与诊断，避免两个 Adapter 重复实现。
- lifecycle 可以调用 Core 与配置所有权处理器；安装发现和宿主配置不渗入 Core。
- shared 的额度预留与去重登记复用项目锁／事务；不以进程内变量替代跨进程一致性。
- CLI/MCP 的协议转换不另做排序、渲染、记录解析或写入事务；status 的宿主证据与 Core 的数据健康分层聚合。
- 不提前增加通用仓储框架、依赖注入容器或未被两个实际调用方需要的包装层。

## 2. 版本与数据

| 版本            | 目标值 | 来源与用途                                   |
| --------------- | ------ | -------------------------------------------- |
| runtime_version | 0.2.0  | M1 迁入的 package metadata，所有产物共同来源 |
| schema_version  | 1      | 现有 Markdown 数据兼容                       |
| api_version     | 2      | CLI/MCP/Adapter 共用契约                     |
| receipt_version | 3      | 接入与配置所有权                             |
| handoff_version | 1      | scoped 交接文件                              |

业务项目数据与本仓库源码目录不同：

| 数据             | 权威来源／约束                                                     |
| ---------------- | ------------------------------------------------------------------ |
| 长期记忆         | `.mwf/` 下原 schema 1 Markdown；不因接入迁移重写                   |
| 索引             | `.mwf/index.md` 可重建；不默认全量注入                             |
| 旧交接           | `.mwf/handoff.md` 只读兼容，仅显式读取                             |
| 接入状态         | `.mwf/local/integration.json`，本机唯一 enabled 来源               |
| 会话映射与 epoch | `.mwf/local/contexts/`，持久路由及有界诊断                         |
| 新交接           | `.mwf/local/handoffs/sessions/`、`tasks/`，有 revision 的持久 JSON |
| 事务与互斥       | 沿用基线 journal、receipt、SQLite 锁；不建立第二套记忆数据库       |

`local` 不是可整体删除的缓存。首次 init 选择 track/ignore，local 始终不进入 Git；attach 不改 Git mode，不自动提交。

## 3. 四条关键调用路径

### 自动恢复

宿主事件 → 验证信任 → 从 cwd 找最近 MWF root → 检查当前客户端 enabled、canonical root 和 runtime → 登记／验证可靠会话身份 → Core 读取已提交记忆 → 锁内按剩余 epoch 预算裁剪并预留 → 宿主正式通道输出 → 记录 submitted，只有取得确认才记 accepted。

未启用则无副作用跳过；最近子项目无效不退回父项目。没有可靠 session 时允许项目级读取，不挑选最新交接。恢复不等待 MCP ready，不把未提交对话写成正式记忆。

### 工具读取与写入

自动 MCP 启动时从独立宿主上下文核对 root，然后固定绑定；每次请求验证 enabled、root、generation 和契约。写操作在锁／事务内再次复核，旧 generation 返回 BINDING_STALE。

Core 处理请求幂等、内容 hash/revision 冲突和事务提交。成功提交的相同 request ID 重试重放原结果；新的冲突不能自动换 revision 覆盖。手动 CLI/MCP 与宿主自动接入分开，停用插件不禁止用户明确读取已有数据。

### 启用与停用

attach：只读计划 → 自有资源提交 → 直接 runtime 验证 → 实际宿主连接验证。不能把 configured 当作 ready。

detach：默认预览；apply 时先 disabled，再撤销仍能证明归属的自有片段。受管值被用户修改则保留并报告 cleanup pending；不回滚整份共享配置，不删记忆和交接。

rebind：绑定实际变化才换 generation；root 改变先停用全部客户端，仅重绑指定客户端，其他客户端不能被顺便启用。

### 旧版迁移

预检 → 停止旧入口 → 独立验证旧数据可读 → 事务清理可证明归属的旧接入 → 生成 disabled 的新 receipt → 新版 attach 与重载验证。普通流程不碰规则文件，迁移只精确删除旧块，marker 本身不证明所有权。

## 4. 模型可见输出

| 用途                  | reference_tokens |    UTF-8 bytes |
| --------------------- | ---------------: | -------------: |
| 自动 bootstrap        |            1,024 |          8 KiB |
| recall                |            2,048 |         16 KiB |
| get                   |            4,096 |         32 KiB |
| 显式扩大读取的最大值  |            8,192 |         64 KiB |
| 单 epoch 自动追加累计 |            8,192 | 累计报告 bytes |

固定离线 `o200k_base`，宿主限制更严时取较小值。预算覆盖最终完整序列化输出，不只计算 body，不重复发送含相同正文的 JSON 和 context_text。

超限优先裁剪完整条目／字段／段落，必要时按 Unicode code point 分片；cursor 固定 hash，交接另固定 scope/revision。最小有效输出放不下时显式读取报 BUDGET_TOO_SMALL，自动追加跳过。事故边界不得被裁掉后只剩无条件修复建议。

去重包含 root/session/epoch/record/hash/detail level；摘要不阻止正文读取。pending/submitted/accepted/unknown 分开，结果不明保守保留额度，不能伪造“模型已读”。

## 5. 构建与发布路径

M1 沿用基线工具链，未来 npm bin 指向 `dist/cli.js`，Pi 声明指向编译扩展；安装后不需要 TypeScript loader 或开发 checkout。

M5/M6 从同次 npm 产物生成 Codex runtime，不维护第二份实现。manifest、runtime 和 Pi 资产版本一致；运行依赖与 tokenizer 词表离线可用。宿主 Pi 不随 MWF 打包，Node 可执行文件仍是外部前置条件。

真实支持状态只看 [兼容矩阵](compatibility.md) 和包验收证据，不由本架构文档推导。

## 0.3.0 当前实现落点

分层自下而上为 contracts → storage → retrieval / context → core → integrations → lifecycle → cli / mcp，`tests/architecture.test.ts` 强制只能向下依赖。

- `contracts/`：schema 1 记录解析与匹配（`records.ts`）、宿主适配契约 `HarnessAdapter`（`harness.ts`）和封闭的受管文件白名单（`managed-surface.ts`）。白名单仅含 `AGENTS.md` 块、`.gitignore` 与 `.codex/config.toml` 块，冻结且无注册/扩展 API；不再包含 `.pi/*` 或 `.agents/skills/*`。
- `storage/`：SQLite 辅助锁、Transaction、journal 与恢复，以及 receipt v3（`receipt.ts`）。只有 storage 按白名单校验 `.mwf/` 以外的写入路径。
- `retrieval/`、`context/`：检索；`context/output.ts` 统一 tokenizer、双预算和 cursor。
- `core/`：共用 execute/schema（`index.ts`）、scoped handoff（`handoff.ts`）、会话身份（`identity.ts`）与诊断（`diagnostics.ts`）。
- `integrations/`：`registry.ts` 是 Pi、Codex 适配器的唯一登记处，生命周期与诊断只经 registry 访问 `HarnessAdapter`；`shared/` 提供 binding、runtime 定位和上下文。
- `lifecycle/`：attach/rebind/detach 与已弃用的 setup，通过 registry 调用适配器。
- `cli.ts`、`mcp.ts` 为薄入口；`src/core.ts` 仍是包根入口（`import {execute} from '@zht7063/mwf'`）。

  0.2.x 的转发桩 `src/storage.ts`、`setup.ts`、`pi-adapter.ts`、`protocol.ts`、`integrations/shared/identity.ts` 已删除，0.1 迁移实现 `lifecycle/migrate.ts` 也已删除；不存在第二套业务实现。

receipt v3：status/doctor 只在内存中把 v2 升级，不写盘；`--apply` 操作先以一次原子替换写入升级后的 receipt，再做其他变更。若 v2 receipt 仍拥有非块资源（0.1 的 `.pi/*`、skills 文件），所有操作返回 `LEGACY_RESOURCE_PENDING` 且不做任何改动。写成 v3 后 0.2.x 无法读取，不可降级，见 [卸载与降级](../packaging/UNINSTALL.md)。

Codex supervisor 为同步锁阻塞提供总截止时间，诊断 marker 独占创建、不等待项目锁，仅保存错误类别和时间，正常会话内容不会写入诊断。错误提示去重依赖本地目录可写；损坏/只读文件系统下只能尽力提示。

协议详情见 [API 2](protocol.md)。安装与升级边界见 [安装](install.md)；0.1 → 0.2 迁移为历史文档（[迁移](migration-0.2.0.md)）。M0 原型不在生产入口导入链内。
