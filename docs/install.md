# 0.2.0 安装与生命周期

这是未发布候选产物的可复跑命令；不要从 npm 拉取假定已发布的 0.2.0。要求 Node ≥22.19.0。运行 `npm run pack:release` 生成 `releases/` 中的 tarball、Codex zip 和 SHA256SUMS。校验 `shasum -a 256 -c SHA256SUMS`。本机实测范围见实施验收记录。

## 独立 CLI

在源码目录外执行（将文件路径替换为实际绝对路径）：

```sh
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/zht7063-mwf-0.2.0.tgz
node node_modules/@zht7063/mwf/dist/cli.js --version
node node_modules/@zht7063/mwf/dist/cli.js init --root /absolute/project --git-mode track
node node_modules/@zht7063/mwf/dist/cli.js doctor --root /absolute/project
```

依赖已捆绑；不要求全局 MWF 或开发依赖。`ignore` 模式仅配置数据 Git 忽略，不改已有索引。重复 init 不覆盖数据或更改 Git mode。复杂 JSON 使用 `--input-file /absolute/input.json`；正文可用 `--body-file`。

## Pi 1.1.0

解压 tarball 到稳定安装路径，以 Pi 正常 package 机制安装：

```sh
mkdir -p /absolute/mwf-install
tar -xzf /absolute/zht7063-mwf-0.2.0.tgz -C /absolute/mwf-install
cd /absolute/project
pi install /absolute/mwf-install/package --local --approve
node /absolute/mwf-install/package/dist/cli.js init --root "$PWD" --git-mode track
node /absolute/mwf-install/package/dist/cli.js attach --root "$PWD" --harness pi
node /absolute/mwf-install/package/dist/cli.js attach --root "$PWD" --harness pi --apply
```

重启/重载并按 Pi 正常流程信任项目。扩展从自身定位 runtime，自动读直接调用 Core，工具通过动态 MCP 注册。不要另配同名 MWF MCP 或旧适配器。`status` 的 configured 不表示宿主已经采用上下文。

## Codex 插件

将 zip 解压到稳定插件目录，经宿主正常插件安装入口安装并信任 hooks。使用**安装后插件缓存内** runtime 的绝对路径，而非 checkout 或全局同名命令：

```sh
node /absolute/installed-plugin/runtime/dist/cli.js init --root /absolute/project --git-mode track
node /absolute/installed-plugin/runtime/dist/cli.js attach --root /absolute/project --harness codex --plugin-root /absolute/installed-plugin
node /absolute/installed-plugin/runtime/dist/cli.js attach --root /absolute/project --harness codex --plugin-root /absolute/installed-plugin --apply
```

包内 `skills/setup/SKILL.md` 提供接入步骤。项目 MCP 使用绝对 Node/runtime 路径，不设置 cwd、不固定 session ID。hooks 目前使用 PATH 中的 `node`，GUI Node 解析必须单独验收；终端成功不代表桌面成功。重载后检查 tools、hooks 信任和后续模型请求。桌面安装入口、信任与重载仍需人工证据，不能用测试脚本的一次性 trust flag 替代。

## 升级、停用、卸载

从新版安装目录执行 `rebind`，预览后加 `--apply`；Codex 同时传新 `--plugin-root`。实际 runtime/root 变化会撤销旧代次，无变化重复执行不换代次。

```sh
node /absolute/runtime/dist/cli.js detach --root /absolute/project --harness pi --apply
node /absolute/runtime/dist/cli.js detach --root /absolute/project --harness codex --apply
```

先持久停用，再清理自有配置。出现 cleanup pending 时保留用户修改和 receipt，解决冲突后重复 detach。不要直接删除 `.mwf/local/`。最后用 `pi remove /absolute/mwf-install/package --local --approve` 或 Codex 正常插件卸载入口移除程序并重载；CLI 安装目录中可执行 `npm uninstall @zht7063/mwf`。这些操作均保留记忆数据。卸载命令的实际覆盖范围见验收记录。
