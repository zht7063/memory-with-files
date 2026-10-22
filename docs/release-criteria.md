# 发布判定标准（0.3.0 起：linux-cli-harness/1）

> **标准已变更。** 2026-10-22 起，按项目负责人决定，0.3.0 及之后的发布判定不再要求
> 真实环境验收（0.2.0 构建计划中的 44 项逐条证据、两个真实宿主、Codex 桌面工作流、
> macOS 与性能报告）。新标准：**在 Linux 命令行终端中，所有 harness 对被打包的同一
> commit 运行通过**，即可发布。本标准**不代表已完全验证**，下列未验证项依旧成立。

## 规则

`npm run pack:release` 读取证据并**计算** `releases/RELEASE-STATUS.json` 中的
`publishable`（`scripts/lib/release-decision.ts`，不写死 true）。每个规则项对应一个证据文件：

| 规则项 | 证据文件 | 产生方式 |
| --- | --- | --- |
| `codex_cli` | `releases/evidence/codex-cli.json` | `tests/integrations/release/codex.py`（Codex CLI + app-server） |
| `pi_cli` | `releases/evidence/pi-cli.json` | `tests/integrations/release/pi.py`（`pi --print`） |

某项判为 `pass` 须同时满足：文件存在且可解析；`harness` 与规则项一致；`status: "pass"`；
`platform: "linux"`；`commit` 等于打包时的 `git rev-parse HEAD`；`dirty: false`；
`tool_count` 为 8（来自对已安装 runtime 的 MCP `tools/list`）；`tool_calls` 非空且每次真实工具调用 `ok: true`。
任一项缺失（`not_run`）、过期、失败或不满足上述条件，`publishable` 即为 `false`。
`npm run test:integrations` 每次运行前删除旧证据，失败时不保留证据文件。

## 运行

```sh
npm ci
npm run pack:release                     # 先产出被 harness 安装的 tgz/zip
MWF_CODEX_BINARY=$(command -v codex) MWF_PI_BINARY=<pi 1.3.x> npm run test:integrations
npm run pack:release                     # 重新计算 publishable
```

Pi 须为 `@earendil-works/pi-coding-agent`（实测 1.3.0）；已废弃的 `@mariozechner/pi-coding-agent` 0.73.x
无 `--approve`，harness 会失败。两个 harness 都使用隔离 home 与回环合成模型端点，不读取用户凭据、不计费。

## 未验证（本标准不覆盖，不得声称已验证）

- Codex 桌面 GUI 工作流
- macOS 主机
- 性能报告
- 真实（计费）模型宿主 / 真实环境 44 项证据

`RELEASE-STATUS.json` 的 `unverified` 字段始终列出以上各项。
