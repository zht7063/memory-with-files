# 0050 CLI 的输出格式、用法错误与 stdin 上限

- 状态：已接受（2026-11-22）；细化 [0028](0028-read-commands-and-output.md)、[0033](0033-consistency-and-limits.md)、[0049](0049-app-defaults.md)
- 注：`install` / `uninstall` 的输出、用法错误与 bin 分发见 [0052](0052-install-and-uninstall.md)。

## 背景

P2 实现 `mwf-cli` 时，下列细节在已有 ADR 中没有规定：纯文本输出的具体格式、`--json` 信封的字段顺序、clap 解析错误在 `--json` 下怎样输出、`--help` / `--version` 的退出码、stdin 上限的错误码，以及 `clap` 的版本。

## 决定

### `--json`

- 成功：`{"ok":true,"data":…}`，一行，末尾换行。`data` 就是 `mwf-app` 返回的 DTO 按 `Serialize` 原样序列化（字段顺序即结构体字段顺序）；`index` 的 `data` 是目录文本字符串，`log` 的是行的数组。
- 失败：`{"ok":false,"error":{"code":…,"message":…,"details":…}}`，`details` 为空时省略（与 `AppError` 一致）。信封手写拼接，保证 `ok` 在最前（`serde_json::Value` 会把键排序）。
- `--json` 是全局选项，可以写在子命令前后。失败时 JSON 写到 stdout，stderr 为空；纯文本模式下错误写到 stderr，格式为 `error[CODE]: message`，stdout 为空。
- `lint` 有 error 时 `--json` 仍是 `"ok": true`（lint 本身成功，报告在 `data` 里），退出码 1。

### 用法错误

- clap 解析失败为 `USAGE`，退出 2。纯文本模式把 clap 的文本（含 `Usage:` 行与 `--help` 提示）写到 stderr；`--json` 模式下 `message` 是同一段文本去掉开头的 `error: `。
- clap 的文本会回显被拒绝的参数与值，所以输出前先隐去密钥（0025）：命中 secret 规则的参数（以及 `--opt=值` 中 `=` 之后的值）在文本中替换为 `[argument withheld: looks like a secret]`；替换后整段文本仍命中（例如 clap 从 `-n值` 里截出的值）时，整段换成固定的 `error: invalid arguments; the details are withheld because they look like a secret` 与 `--help` 提示。两种输出模式相同。
- 解析失败时还没有 `Cli` 结构体，所以先扫描参数：`--` 之前出现 `--json` 即按 JSON 输出用法错误。极少数情况下（例如 `--title --json` 把 `--json` 当成标题值）用法错误也会按 JSON 输出；解析成功后一律以 clap 的结果为准。
- 没有子命令时（`mwf`）打印帮助到 stderr，退出 2（clap 的默认行为，也是用法错误）。`--help`、`--version` 打印到 stdout，退出 0。
- 任何输出（含 `--help`、`--version` 与 `--json` 下的用法错误）写入或 flush stdout 失败（如 `/dev/full`、管道已关闭）时退出 1。

### 纯文本格式

无颜色、无表格框线（0028），由 `crates/mwf/tests/snapshots/` 的快照固定：

- `show`：`slug:`、`rev:`、`title:`、`type:`、`summary:`、`tags:`（逗号分隔）、`status:`、`created:`、`updated:` 各一行，空行，正文，然后 `links out:` 与 `links in:` 两节，每个链接一行 `  <slug>: <title> — <summary>`；悬空链接为 `(missing)`，不合法的页面为 `(invalid page, run \`mwf lint\`)`；没有链接时写 `none`。
- `search`：每个结果两行：`<slug>  <type>  <status>  score <分数，3 位小数>  rev <rev>`，下一行缩进 `<title> — <summary>`。无结果为 `no results`。
- `list`：同 `search`，没有 score；有 tags 时第三行 `  tags: …`。无页面为 `no pages`。
- `index`：目录原文。`log`：`log.md` 的行原样。
- `lint`：每个问题一行 `<severity>[<rule>] <page>: <message>`（全项目规则没有 ` <page>`），最后一行 `errors: N, warnings: M`。
- 输出不复制密钥（0049）：写命令与 `delete` 的纯文本输出中，命中 secret 规则的 slug（含 `rename` 的源 slug、`also updated` / `unlinked` / 相关页中的 slug）显示为 `[slug withheld: looks like a secret]`，相关页命中的标题、summary 显示为 `[title withheld: looks like a secret]`、`[summary withheld: looks like a secret]`，`trashed:` 路径命中时显示为 `[path withheld: looks like a secret]`。`--json` 的 `data` 仍是 DTO 原样。读命令（`show`、`list`、`search`）照常给出存量页面的 slug，以便用户找到并改名或删除它。
- 写命令：第一行 `created|updated|archived|unarchived|renamed <old> -> <slug>`，没有改动时为 `unchanged <slug>`；第二行 `rev: <rev>`；之后依次是 `warning[<rule>]: …`、`also updated: …`、`related pages not linked yet:` 与每页一行 `  <slug>: <title> — <summary>`（0040）。
- `delete`：`deleted <slug>`、`trashed: <路径>`，有 `--unlink` 改写时 `unlinked: …`，然后是警告。

### 参数

- `search` 的多个位置参数用空格连接为查询串。
- `--title`、`--summary`、`--old`、`--new` 接受以 `-` 开头的值（Markdown 列表项）。
- `patch` 的 `--old` 与 `--old-file`（`--new` 与 `--new-file`）互斥，必须给其一。

### stdin 上限

- stdin（`new`、`write` 的正文）与 `--old-file` / `--new-file` 都按 1 MB（1048576 字节）流式计数，读到第 1048577 个字节即停止并返回 `TOO_LARGE`（`details.field` 为 `stdin` 或 `--old-file` / `--new-file`，`details.limit` 为 1048576），不读剩余输入（0033）。通过之后正文再受 `mwf-app` 的 100 KB 检查（0049）。
- 输入不是 UTF-8 为 `INVALID_FIELD`；`--*-file` 打不开为 `IO`，信息与 `details.path` 给出路径；路径命中 secret 规则时信息中写 `[path withheld: looks like a secret]`，只附错误种类，并省略 `details`。

### `clap` 版本

精确固定为 `=4.6.3`：`clap_derive` 4.6.4 起依赖 `syn` 3，而 `serde_derive 1.0.228`（store、app 中精确固定）依赖 `syn` 2，`deny.toml` 禁止重复主版本。等 serde 升级到 `syn` 3 时一起升级。启用 `wrap_help` 并把帮助宽度固定为 100 列：`divan`（mwf-search 的 dev 依赖）会打开 `wrap_help`，不固定时 `--help` 的换行随一起构建的 crate 与终端宽度变化。

### bin 与测试

- `mwf` bin 目前把全部参数交给 `mwf-cli`；`hook`（P3）与 `install` / `uninstall`（P4）在对应适配器实现时再分发。
- 端到端测试只经由编译出的 `mwf` 二进制（`assert_cmd`），不以 dev 依赖引入 workspace crate：`check-crate-graph.sh` 把 dev 边也计入拓扑图。快照记录完整会话（命令行、stdin、stdout、stderr、退出码），过滤掉临时目录、时间戳与 rev。

## 后果

- [cli.md](../cli.md) 记录退出码与输出约定；[crates/adapters.md](../crates/adapters.md) 记录 `Io` 的形状与 `clap` 的版本。
