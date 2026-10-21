# 数据初始化资源

状态：已使用。随 npm 包发布（package.json `files`），由 Core `init` 复制到项目 `.mwf/`。

## 文件

- `config.json`、`index.md`、`inbox.md`、`handoff.md`、`protocol.md`：schema 1 数据目录模板与简短协议说明。
- `legacy-agents-block.md`：0.1 旧 AGENTS 块模板，仅供迁移识别归属，不写入新项目。

## 约束

- 模板只描述数据格式；正常 init 不写 AGENTS/CLAUDE。
- 本目录不是项目实际 `.mwf` 数据，不存放 receipt 或会话状态。
- `legacy-agents-block.md` 与 `assets/mwf-template/agents-block.md` 中前者曾由 0.2.x 的 `migrate --from 0.1` 使用（0.3 已移除，仅作历史参考）；包内只发布 mwf-template 中的 `agents-block.md`。

## 依据

- 构建规范 §4、§13；L03–L04、G02–G04。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
