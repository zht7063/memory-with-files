# M0 宿主最小实验

这是可执行的可行性探针，不是 MWF 0.2.0 实现。使用合成 `memory.txt`、最小 stdio MCP 与本机 HTTP 模型协议夹具；没有调用真实模型，也没有迁入上游源码。新增 binding 探针可从外部固定基线目录导入真实存储。

## 运行

前置：Python 3、Node、Pi 1.1.0，以及待测 Codex 可执行文件。需要允许监听 `127.0.0.1` 随机端口；沙箱拒绝监听时，按执行环境的授权机制运行。

```bash
python3 tests/integrations/m0/pi-probe.py
python3 tests/integrations/m0/codex-probe.py /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
```

每次创建独立临时目录，隔离 Pi 配置或 Codex home，保留合成实验记录，结束时关闭本次启动的宿主及本机端点。不会修改当前项目接入或已有个人配置。输出 `evidence_dir` 可用于复核；确认不再需要后可删除该次临时目录。

Pi 使用正常 `pi install LOCAL_PACKAGE --local` 和 RPC 启动，未手工 import 宿主内部 loader。检查受信任／未信任、注册／注销、后续请求工具列表、会话 replacement、reload、配置覆盖、中文空格路径与延迟初始化。

Codex 使用正常本地 marketplace 安装 root `plugin.json`，先验证未信任 hooks 被跳过，再以官方 `--dangerously-bypass-hook-trust` 单次选项执行本脚本生成且已审查的合成 hooks。该选项只用于隔离实验，不证明 GUI 的持久信任流程。最后通过 app-server 调用实际 MCP 工具。

## 边界

- `mcp-probe.mjs` 只比对宿主 cwd 与测试 root，不包含完整最近项目发现、enabled、generation、真实记忆读取或事务；复制目录实验只证明宿主提供了独立 cwd 以及探针可拒绝错误绑定。不能勾选完整 L11。
- Pi `getAllTools()` 在注销后可能仍返回工具元数据；验证下一次实际模型请求不含该工具，不能只查注册列表。
- Pi 在 MCP 慢启动时可能先等待 MCP，再触发 `before_agent_start`。探针在 `session_start` 提前读取快照，分别测量读取与注入时序。
- Codex 的合成请求可以在 MCP ready 前完成，结束会话会关闭尚未就绪的连接。另用零延迟 server 验证握手和工具调用。
- loopback 实际接收的请求与 `before_provider_request` 观测证明输出通道可用；不代表完整生产记忆恢复、模型遵守记忆或 G09 发布验收已通过。
- GUI 安装／信任／重载、GUI Node 路径、Linux、最低 Node 版本、真实持久记忆和完整故障矩阵尚未覆盖。

结果见 [M0 验证报告](../../../docs/validation/M0-validation.md)。

## 真实数据复制与撤销原型（10-16）

先在固定提交 `7b8be0e59647c90227c0cb945b279d7fa7ab14ef` 的 `packages/mwf` 中运行 `npm ci && npm run build`，再执行：

```bash
python3 tests/integrations/m0/binding-probe.py /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex /absolute/fixed-upstream/packages/mwf
```

脚本创建临时 Git 项目、真实 schema 1 记录与合成 v2 receipt，通过 Codex 原生 MCP 工具调用验证正常读写、完整复制负例、最近项目边界、disabled、generation 与启动拒绝不可复活。所有拒绝均断言 A/B 文件哈希不变。基线 init 会在临时 fixture 创建 AGENTS.md；接入实验不修改它，不触及用户项目。

这是顺序可行性原型；未完成生产事务内撤销校验、runtime/API 校验或恶意路径防护，不等于新版完整 L11，也不覆盖 Pi 的真实数据读写。宿主无需模型请求，使用隔离 CODEX_HOME，结束时终止 app-server。
