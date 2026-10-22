# 0.3.0 安装与生命周期

这是未发布候选产物的可复跑命令；不要从 npm 拉取假定已发布的 0.3.0。要求 Node ≥22.19.0。运行 `npm run pack:release` 生成 `releases/` 中的 tarball、Codex zip 和 SHA256SUMS。校验 `shasum -a 256 -c SHA256SUMS`。本机实测范围见实施验收记录。

## 独立 CLI

在源码目录外执行（将文件路径替换为实际绝对路径）：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/zht7063-mwf-0.3.0.tgz
node node_modules/@zht7063/mwf/dist/cli.js --version
node node_modules/@zht7063/mwf/dist/cli.js init --root /absolute/project --git-mode track
node node_modules/@zht7063/mwf/dist/cli.js doctor --root /absolute/project
```

`status` 报告数据健康，并按客户端列出 `installed`（runtime 文件是否存在、版本是否与 receipt 记录一致）、`configured`（enabled、binding_generation、issues 如 `ROOT_MISMATCH`、`RUNTIME_MISMATCH`、`OWNERSHIP_CONFLICT:<path>`）和 `probed`（attach 时的探测证据；缺失或过期报 `not_run` / `stale_or_invalid_evidence`）。`doctor` 做更完整的数据检查。两者可用 `--diagnostic-limit N`（1–100，默认 5）限制每个上下文返回的最近诊断条数。CLI 子命令没有单独帮助；`--help` 列出全部命令。

依赖已捆绑；不要求全局 MWF 或开发依赖。`ignore` 模式仅配置数据 Git 忽略，不改已有索引。重复 init 不覆盖数据或更改 Git mode。复杂 JSON 使用 `--input-file /absolute/input.json`；正文可用 `--body-file`。

## Pi

宿主包为 `@earendil-works/pi-coding-agent`（T07 实测 1.3.0；旧包名 `@mariozechner/pi-coding-agent` 停在 0.73.1，不再使用）。解压 tarball 到稳定安装路径，以 Pi 正常 package 机制安装：

```sh
mkdir -p /absolute/mwf-install
tar -xzf /absolute/zht7063-mwf-0.3.0.tgz -C /absolute/mwf-install
cd /absolute/project
pi install /absolute/mwf-install/package --local --approve
node /absolute/mwf-install/package/dist/cli.js init --root "$PWD" --git-mode track
node /absolute/mwf-install/package/dist/cli.js attach --root "$PWD" --harness pi
node /absolute/mwf-install/package/dist/cli.js attach --root "$PWD" --harness pi --apply
```

第一条 attach 只预览。未传 `--plugin-root` 时，从项目 `.pi/settings.json` 和 `$PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）的 packages 定位 runtime；找不到或多于一个报 `PLUGIN_RUNTIME_REQUIRED`。重启/重载并按 Pi 正常流程信任项目。扩展从自身定位 runtime，自动读直接调用 Core，工具通过动态 MCP 注册。不要另配同名 MWF MCP 或旧适配器。`status` 的 configured 不表示宿主已经采用上下文。

## Codex 插件

使用 `npm run pack:release` 生成的 `releases/mwf-codex-0.3.0.zip`。包内包含版本一致的 `plugin.json`、`runtime/package.json`、编译后的 `runtime/dist`、捆绑依赖、hooks 和 skills，可直接解压安装。zip 由纯 Node 写出（条目按名称排序、时间戳固定为 1980-01-01），不依赖系统 `zip`；同目录的 `RELEASE-STATUS.json` 标记 `publishable: false`。仓库内 `packaging/codex/` 只是组装来源，安装请用 zip。

将 zip 解压到稳定插件目录，经宿主正常插件安装入口安装并信任 hooks。使用**安装后插件缓存内** runtime 的绝对路径，而非 checkout 或全局同名命令：

```sh
node /absolute/installed-plugin/runtime/dist/cli.js init --root /absolute/project --git-mode track
node /absolute/installed-plugin/runtime/dist/cli.js attach --root /absolute/project --harness codex --plugin-root /absolute/installed-plugin
node /absolute/installed-plugin/runtime/dist/cli.js attach --root /absolute/project --harness codex --plugin-root /absolute/installed-plugin --apply
```

未传 `--plugin-root` 时，runtime 若位于插件 `runtime/` 内则使用该插件，否则扫描 `$CODEX_HOME/plugins/cache`（默认 `~/.codex`）：每个插件目录下若有 `local` 版本目录则选它，否则选语义化版本最高的目录。若从另一份 CLI 执行 attach/rebind，CLI 会转交给定位到的已安装 runtime；该 runtime `--version` 与包版本不符时报 `RUNTIME_MISMATCH`。`--apply` 写入 `.codex/config.toml` 中受管的 `[mcp_servers.mwf]` 块（文件已被 Git 跟踪时只警告，不改索引），随后运行 direct 与 MCP 探测并记录到 `.mwf/local/integration.json`；`host_confirmed` 保持 `unknown`，宿主是否真正加载需重载后自行确认。包内 `skills/setup/SKILL.md` 提供接入步骤。项目 MCP 使用绝对 Node/runtime 路径，不设置 cwd、不固定 session ID。hooks 目前使用 PATH 中的 `node`，GUI Node 解析必须单独验收；终端成功不代表桌面成功。重载后检查 tools、hooks 信任和后续模型请求。桌面安装入口、信任与重载仍需人工证据，不能用测试脚本的一次性 trust flag 替代。

## 从 0.2.x 升级与不可降级

0.3.0 使用 receipt v3。`status`、`doctor` 只在内存中读取并升级 v2 receipt，不写盘；任一 `--apply` 操作先以一次原子替换写入 v3 receipt，再做其他变更。写成 v3 后 0.2.x 无法读取该 receipt，**不能降级**：如需回到 0.2.x，必须先用 0.3.0 执行 `detach --harness all --apply`，再按 [UNINSTALL](../packaging/UNINSTALL.md#no-downgrade-after-receipt-v3) 处理。

0.3.0 不再支持 0.1 安装：0.1 项目返回 `UNSUPPORTED_LEGACY_INSTALL` 且不写入任何文件；v2 receipt 若仍拥有 0.1 的 `.pi/*` 或 skills 资源，所有操作返回 `LEGACY_RESOURCE_PENDING` 且不做改动。两种情况都须先用 0.2.x 迁移或 detach，见 [0.1 遗留清理](../packaging/UNINSTALL.md#legacy-01-cleanup)。

启用 Pi 时，`doctor` 会在 `.pi/mcp.json` 存在冲突的 `mcpServers.mwf` 条目时报告 `OWNERSHIP_CONFLICT`（`ok: false`）；`status` 不报告此项。

## 升级、停用、卸载

从新版安装目录执行 `rebind`，预览后加 `--apply`；Codex 同时传新 `--plugin-root`。实际 runtime/root 变化会撤销旧代次，无变化重复执行不换代次。

```sh
node /absolute/runtime/dist/cli.js detach --root /absolute/project --harness pi --apply
node /absolute/runtime/dist/cli.js detach --root /absolute/project --harness codex --apply
```

`detach --harness all` 可一次停用两个客户端；不加 `--apply` 只预览。先持久停用，再清理自有配置。出现 cleanup pending 时保留用户修改和 receipt，解决冲突后重复 detach。不要直接删除 `.mwf/local/`。最后用 `pi remove /absolute/mwf-install/package --local --approve` 或 Codex 正常插件卸载入口移除程序并重载；CLI 安装目录中可执行 `npm uninstall @zht7063/mwf`。这些操作均保留记忆数据。卸载命令的实际覆盖范围见验收记录。

单宿主 detach 仅停用指定客户端；另一个客户端的 enabled、generation 和配置不变。
停用后旧连接立即拒绝请求；Pi 在下一个扩展事件注销动态工具，Codex 需要重载才能
让宿主工具列表移除旧项目配置。不要把尚未重载的工具列表当成可用连接。

恢复顺序：detach → 正常宿主卸包 → 完全退出/重载 → 重装 → 接入前重载并确认仍停用
→ 从新安装路径 attach → 再重载。仅重装不会重新启用 receipt 中已停用的客户端。
重新接入会更换该客户端 generation，旧连接仍不可用。保留整个 `.mwf/`，包括
Markdown、`.mwf/local/contexts/` 身份映射和 `.mwf/local/handoffs/` 的 session/task
交接；重装后可用原 session_ref 或 task ID 显式读取。不要仅备份长期 Markdown。

MCP 工具的 `project_root` 可省略，默认使用服务绑定的 root。若传入，必须与绑定 root 完全一致：不同路径、符号链接别名或含 `../` 的路径都返回 `ROOT_MISMATCH`。注意：即使当初是通过符号链接路径接入（绑定的是解析后的真实路径），之后再传该符号链接路径也会被拒绝。

双宿主 CLI 与 GUI 的逐步验证及未运行项目见
[T09 宿主会话验证](validation/t09-host-sessions.md)。本地自动测试只模拟宿主事件和
安装目录移除/重建，不证明真实宿主卸包或 GUI 重载成功。

## 已弃用：setup

`setup --root … [--harness codex|pi|pi,codex]` 仍可用，但已弃用；未指定 `--harness` 时默认 codex。传入 `pi,codex` 时按顺序逐个运行各客户端的 setup，并汇总结果。`attach` 与 `rebind` 必须显式传 `--harness pi|codex`，否则返回 INVALID_INPUT（退出码 2）。新流程请用 `init` + `attach`。
