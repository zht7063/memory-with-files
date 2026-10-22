# Codex 插件打包

状态：包含插件 manifest 与 SessionStart/UserPromptSubmit hooks；`npm run pack:release` 从同次 npm 产物组装带完整 runtime 的可安装 zip（T11）。桌面正常发现、GUI Node、信任/重载和故障注入仍未实测。

## 内容

- `plugin.json`：插件名 `mwf`，`extensions.com.openai` 声明 `hooks: ./hooks/hooks.json` 与 `onboardingSkill: ./skills/setup/SKILL.md`。`version` 为 `0.3.0`，打包时由 `scripts/pack-release.ts` 以 package.json 的版本覆盖，保证与 runtime 一致。
- `hooks/hooks.json`：SessionStart（matcher `startup|resume|clear|compact`）与 UserPromptSubmit 调用 `runtime/dist/integrations/codex/runner.js`，timeout 5 秒。

## 组装

`npm run pack:release` 执行 npm pack，把 tarball 解压为插件内 `runtime/`，复制本目录的 plugin.json 与 hooks、`assets/skills/` 为 `skills/`，用纯 Node 的 `scripts/lib/zip.ts`（按名称排序、固定 1980-01-01 时间戳）生成 `releases/mwf-codex-<version>.zip`，并写出 tarball 与 zip 的 SHA256SUMS 以及 `RELEASE-STATUS.json`（`publishable` 由 Linux CLI harness 证据计算，见[发布判定标准](../../docs/release-criteria.md)）。不 publish。`tests/release.test.ts` 校验 zip 往返与包内 manifest/runtime 完整性。

## 使用

本目录不能直接作为插件安装（缺 `runtime/`、`skills/`）。运行 `npm run pack:release`，用 `shasum -a 256 -c SHA256SUMS` 校验后，把 `mwf-codex-0.3.0.zip` 解压到稳定目录，经 Codex 正常插件入口安装并信任 hooks，再按 [安装文档](../../docs/install.md#codex-插件) 用插件缓存内 runtime 执行 init 与 attach。

## 约束与未验证

- manifest 不声明 MWF MCP；MCP 由 attach 写入项目配置。
- hooks 依赖 PATH 中的 `node`；GUI 下 Node 路径与桌面信任流程未验收。

## 依据

- 构建规范 §10.1、§15；L01–L02、G08–G10。
- 当前分层与目录落点见仓库根目录下的 `docs/architecture.md`；`docs/build-plan-0.2.0.md` 为 0.2.0 历史执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。

T08 的逐场景桌面证据和操作步骤见 [桌面验收清单](../../docs/validation/desktop-checklist.md#t08-可执行矩阵与证据边界)。CLI trust bypass 不能代替 GUI 正常信任；未取得宿主证据的场景保持 not_run/partial。

## 停用与卸载

```sh
node /absolute/installed-plugin/runtime/dist/cli.js detach --root /absolute/project --harness codex --apply
codex plugin remove mwf@<marketplace>        # 或桌面插件卸载入口
codex plugin marketplace remove <marketplace> # 若曾添加本地 marketplace
```

detach 删除项目 `.codex/config.toml` 中的 `# mwf:mcp:start…end` 块（文件由 MWF 创建且变空时删除文件，空 `.codex/` 目录保留）。插件卸载移除 `~/.codex/plugins/cache/<marketplace>/mwf/` 与 `~/.codex/config.toml` 中 `[plugins."mwf@<marketplace>"]`。`.mwf/` 记忆数据保留；完整清单见 [../UNINSTALL.md](../UNINSTALL.md)。
