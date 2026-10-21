# 0.2.0 安装与生命周期

这是未发布候选产物的可复跑命令；不要从 npm 拉取假定已发布的 0.2.0。要求 Node ≥22.19.0。运行 `npm run pack:release` 在 `releases/` 生成 4 个文件：

- `zht7063-mwf-0.2.0.tgz`：独立 CLI 与 Pi 共用的 npm 包
- `mwf-codex-0.2.0.zip`：Codex 插件
- `SHA256SUMS`：上面两个产物的校验和
- `RELEASE-STATUS.json`：发布状态，`publishable: false`

安装前在 `releases/` 内校验：Linux 用 `sha256sum -c SHA256SUMS`，macOS 用 `shasum -a 256 -c SHA256SUMS`。本机实测范围见实施验收记录。

## 独立 CLI

在源码目录外执行（将文件路径替换为实际绝对路径）：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/zht7063-mwf-0.2.0.tgz
node node_modules/@zht7063/mwf/dist/cli.js --version
node node_modules/@zht7063/mwf/dist/cli.js init --root /absolute/project --git-mode track
node node_modules/@zht7063/mwf/dist/cli.js doctor --root /absolute/project
```

`status` 报告数据健康，并按客户端列出 `installed`（runtime 文件是否存在、版本是否与 receipt 记录一致）、`configured`（enabled、binding_generation、issues 如 `ROOT_MISMATCH`、`RUNTIME_MISMATCH`、`OWNERSHIP_CONFLICT:<path>`）和 `probed`（attach 时的探测证据；缺失或过期报 `not_run` / `stale_or_invalid_evidence`）。`doctor` 做更完整的数据检查。两者可用 `--diagnostic-limit N`（1–100，默认 5）限制每个上下文返回的最近诊断条数。CLI 子命令没有单独帮助；`--help` 列出全部命令。

依赖已捆绑；不要求全局 MWF 或开发依赖。`ignore` 模式仅配置数据 Git 忽略，不改已有索引。重复 init 不覆盖数据或更改 Git mode。复杂 JSON 使用 `--input-file /absolute/input.json`；正文可用 `--body-file`。

## Pi

宿主包为 `@earendil-works/pi-coding-agent`（T07 实测 1.3.0；旧包名 `@mariozechner/pi-coding-agent` 停在 0.73.1，不再使用）。Pi 从目录加载扩展，不能直接 `pi install` 一个 `.tgz` 文件：先把 tarball 解压到稳定安装路径，再对解压出的 `package/` 目录执行安装。Pi 不会拷贝这个目录，安装期间不要删除它。Pi 通过包内 `package.json` 的 `pi.extensions` 字段找到扩展。

```sh
mkdir -p /absolute/mwf-install
tar -xzf /absolute/zht7063-mwf-0.2.0.tgz -C /absolute/mwf-install
cd /absolute/project
pi install /absolute/mwf-install/package --local --approve
node /absolute/mwf-install/package/dist/cli.js init --root "$PWD" --git-mode track
node /absolute/mwf-install/package/dist/cli.js attach --root "$PWD" --harness pi
node /absolute/mwf-install/package/dist/cli.js attach --root "$PWD" --harness pi --apply
```

第一条 attach 只预览。未传 `--plugin-root` 时，从项目 `.pi/settings.json` 和 `$PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）的 packages 定位 runtime；找不到或多于一个报 `PLUGIN_RUNTIME_REQUIRED`。重启/重载并按 Pi 正常流程信任项目。扩展从自身定位 runtime，自动读直接调用 Core，工具通过动态 MCP 注册。不要另配同名 MWF MCP 或旧适配器。`status` 的 configured 不表示宿主已经采用上下文。

## Codex 插件

使用 `npm run pack:release` 生成的 `releases/mwf-codex-0.2.0.zip`。包内包含版本一致的 `plugin.json`、`runtime/package.json`、编译后的 `runtime/dist`、捆绑依赖、hooks 和 skills，可直接解压安装。zip 由纯 Node 写出（条目按名称排序、时间戳固定为 1980-01-01），不依赖系统 `zip`；同目录的 `RELEASE-STATUS.json` 标记 `publishable: false`。仓库内 `packaging/codex/` 只是组装来源，安装请用 zip。

将 zip 解压到稳定插件目录，经宿主正常插件安装入口安装并信任 hooks。使用**安装后插件缓存内** runtime 的绝对路径，而非 checkout 或全局同名命令：

```sh
node /absolute/installed-plugin/runtime/dist/cli.js init --root /absolute/project --git-mode track
node /absolute/installed-plugin/runtime/dist/cli.js attach --root /absolute/project --harness codex --plugin-root /absolute/installed-plugin
node /absolute/installed-plugin/runtime/dist/cli.js attach --root /absolute/project --harness codex --plugin-root /absolute/installed-plugin --apply
```

未传 `--plugin-root` 时，runtime 若位于插件 `runtime/` 内则使用该插件，否则扫描 `$CODEX_HOME/plugins/cache`（默认 `~/.codex`）：每个插件目录下若有 `local` 版本目录则选它，否则选语义化版本最高的目录。若从另一份 CLI 执行 attach/rebind，CLI 会转交给定位到的已安装 runtime；该 runtime `--version` 与包版本不符时报 `RUNTIME_MISMATCH`。`--apply` 写入 `.codex/config.toml` 中受管的 `[mcp_servers.mwf]` 块（文件已被 Git 跟踪时只警告，不改索引），随后运行 direct 与 MCP 探测并记录到 `.mwf/local/integration.json`；`host_confirmed` 保持 `unknown`，宿主是否真正加载需重载后自行确认。包内 `skills/setup/SKILL.md` 提供接入步骤。项目 MCP 使用绝对 Node/runtime 路径，不设置 cwd、不固定 session ID。hooks 目前使用 PATH 中的 `node`，GUI Node 解析必须单独验收；终端成功不代表桌面成功。重载后检查 tools、hooks 信任和后续模型请求。桌面安装入口、信任与重载仍需人工证据，不能用测试脚本的一次性 trust flag 替代。

## 升级、停用、卸载

从新版安装目录执行 `rebind`，预览后加 `--apply`；Codex 同时传新 `--plugin-root`。实际 runtime/root 变化会撤销旧代次，无变化重复执行不换代次。

```sh
node /absolute/runtime/dist/cli.js detach --root /absolute/project --harness pi --apply
node /absolute/runtime/dist/cli.js detach --root /absolute/project --harness codex --apply
```

`detach --harness all` 可一次停用两个客户端；不加 `--apply` 只预览。先持久停用，再清理自有配置。成功时状态为 `disabled_clean`；出现 `disabled_cleanup_pending` 时保留用户修改和 receipt，解决冲突后重复 detach。在 detach 报告 `disabled_clean` 且宿主已退出之前，不要删除 `.mwf/local/`。

然后移除程序并重载宿主：

- Pi：`pi remove /absolute/mwf-install/package`（当初用 `--local` 安装就加 `--local`），再 `rm -rf /absolute/mwf-install`。
- Codex：GUI 卸载，或 `codex plugin remove mwf@<marketplace>`；如果当初添加过 marketplace，再执行 `codex plugin marketplace remove <marketplace>`。解压出的 zip 目录自行删除。
- 独立 CLI：在其安装目录执行 `npm uninstall @zht7063/mwf`。

以上操作都保留记忆数据。卸载后会留下几处需要手动处理的东西：

- `.mwf/local/`（receipt、锁文件、会话状态等本机状态）：detach 后仍在，确认 `disabled_clean` 后可 `rm -rf`。
- `.mwf/` 其余部分是记忆数据，默认保留；不想要数据才删。
- `.gitignore` 里 `# memory-with-files:start … end` 一段：detach 不删，需要手动删。如果 `.gitignore` 是 `init` 新建的，删掉这段后文件为空，可以把整个文件删掉。
- 空的 `.codex/` 目录：detach 删掉受管块（和 MWF 新建的 `config.toml`）后留下，可 `rmdir`。
- 宿主自己的残留，不属于 MWF：Pi settings 里的 `"packages": []`，以及 `~/.codex/plugins/cache/<marketplace>/` 空目录。

完整的写入清单、逐步卸载命令和已知遗留见 [packaging/UNINSTALL.md](../packaging/UNINSTALL.md)。

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
