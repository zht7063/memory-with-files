# 0053 端到端冒烟测试的后续：shell 守卫解包 `-c`，以及几处有意为之的行为

- 状态：已接受（2026-11-23）；细化 [0024](0024-bypass-guard.md)、[0025](0025-secret-scanning.md)、[0027](0027-summary-and-index-md.md)、[0049](0049-app-defaults.md)、[0050](0050-cli-output-and-usage-errors.md)、[0052](0052-install-and-uninstall.md)

## 背景

在 orb 里对 `v2` 做的端到端冒烟测试（安装、读写、hook、卸载）报告了一个守卫漏洞和六处粗糙之处。逐条复现后，结论如下。

## 复现与决定

### 1. shell 守卫不解包 `bash -c`（缺陷，已修复）

复现：`bash -c 'rm .mwf/pages/x.md'`、`bash -lc "sed -i s/a/b/ .mwf/pages/x.md"`、`sh -c 'mv a .mwf/pages/x.md'`，以及 Codex 以 argv 传来的 `["bash", "-lc", "rm .mwf/pages/x.md"]`，`shell_writes_mwf` 都返回 false：它只看每段命令的第一个词，`bash` 不在任何写命令列表里；argv 又被直接用空格拼接，丢掉了引号。

决定：

- 守卫按 shell 引号规则（`'…'` 原样，`"…"` 与裸词中的反斜杠转义）切词，找出位于命令位置（跳过 `sudo`、`env`、`X=1` 等前缀）的 `sh`、`bash`、`zsh`、`dash`、`ksh`、`mksh`、`ash`；选项中带 `c` 的短选项簇（`-c`、`-lc`、`-ec`……）表示第一个非选项参数是脚本。`-o` / `-O` 吃掉下一个参数，`--login` 等长选项跳过。脚本递归按同样规则检查，嵌套最多 8 层。
- Codex 的 argv 先把每个元素单引号转义再拼成命令行，守卫读回的词与 argv 相同。
- 仍是护栏（0024）：变量、`eval`、`cd .mwf && …`、超过 8 层的嵌套等照旧检测不到。

### 2. `mwf --help` 不列 `install` / `uninstall` / `hook`（有意为之，补提示）

0052 规定这三个命令由 bin 在 clap 之前分发，不出现在 clap 的 `Commands:` 中。保持这一点，但在顶层帮助末尾加一段 `Host integration` 说明，列出三条命令的用法，并指出 `install` / `uninstall` 各有 `--help`（`hook` 只由宿主调用，没有 `--help`）。

### 3. `index.md` 的表头是中文（有意为之，保持）

0027 规定了 `index.md` 的格式，包括 `<!-- 由 mwf 生成，勿手改 -->` 与 `# 目录` 两行。改成英文会让每个已有项目的 `index.md` 与渲染结果不一致（`lint` 报 stale index，下一次写入时整份重写），而且 0027 是格式规定而非示例。保持不变；要改需另立 ADR 取代 0027 的这一部分。

### 4. `SECRET_DETECTED` 的行号包含 frontmatter（有意为之，信息写明）

0049 规定 secret 扫描比较整个页面文件，行号是页面文件的行号。正文第 1 行在 frontmatter 之后，所以报成第 10 行左右是正确的。信息由 `at line N` 改为 `at line N of the page file`（写命令的错误与 `lint` 的 `secret` 规则相同），`details.findings[].line` 不变。

### 5. `list` / `search` 不显示 frontmatter 不合法的页面（有意为之，写入文档）

不合法的页面文件不进入链接图、`index.md` 与搜索（0049）；`list --status all` 的 `all` 指 active 与 archived 两种状态，不包括无法解析的文件。为它们加警告会改变 `list` / `search` 的 `--json` 数据形状（0050 规定 `data` 是结果数组）。不改行为：`lint`（以及 Stop hook 的检查）报告它们，`show` 也给出解析错误。cli.md 与 skill 的命令速查写明这一点。

### 6. `uninstall` 留下空的 `skills/` 与 `~/.agents/skills/`（有意为之，保持）

0052 规定 `uninstall` 只删除 `mwf/` 及其下变空的 `references/`，上一级目录（`skills/`、`.agents/`）不删：这些目录也可能由用户或其他工具创建，mwf 无法知道是不是它建的。`.mwf-bak-*` 备份同样有意保留（0052）。

### 7. 正文末尾没有换行算作改动（有意为之，写入文档）

正文按 stdin 原样存储，mwf 不做规范化。`hello` 与 `hello\n` 是不同的文件内容，`rev`（文件字节的哈希）也不同，所以从一个写到另一个报 `updated`、`changed: true`，并追加日志行；写入同样的字节才是 `unchanged`。规范化会让 `patch` 的 `--old` 匹配与 `rev` 都偏离用户给的字节，不采用。

## 后果

- `crates/mwf-hooks/src/guard.rs` 增加 `-c` 脚本的解包与 `argv_command`，有对应回归测试；顶层帮助与 secret 信息的快照随之更新。
- [cli.md](../cli.md) 与 skill 的命令速查记录 5、7 两条。
