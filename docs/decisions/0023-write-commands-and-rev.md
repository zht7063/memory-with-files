# 0023 写命令与写冲突检测

- 状态：已接受（2026-11-20）；落实 [0016](0016-all-writes-through-mwf.md)
- 注：文中 `[[slug]]` 链接语法已被 [0038](0038-markdown-links.md) 取代，改为 `[文字](slug.md)`。

## 决定

### 写命令

| 命令 | 作用 |
| --- | --- |
| `mwf new <slug>` | 新建页面；frontmatter 用参数，正文从 stdin |
| `mwf write <slug> --rev <rev>` | 整页替换正文 |
| `mwf patch <slug> --old … --new …` | 精确字符串替换，`old` 必须唯一匹配 |
| `mwf set <slug> --title/--type/--tags/--summary …` | 修改 frontmatter 字段 |
| `mwf archive <slug>` / `mwf unarchive <slug>` | 改 `status` |
| `mwf rename <old> <new>` | 改 slug，并改写全部 `[[old]]` 入链 |
| `mwf delete <slug>` | 见 [0026](0026-delete-to-trash.md) |

参数细节见 [cli.md](../cli.md)。

### 冲突检测

- 读命令（`show`、`search`）返回每页的 `rev`：页面文件内容哈希的前 12 个十六进制字符。
- `write` 必须带 `--rev`，与当前不一致即拒绝（`REV_MISMATCH`），提示先重新读取。
- `patch` 不需要 rev："旧字符串唯一匹配"本身即检查（无匹配 `PATCH_NO_MATCH`，多处匹配 `PATCH_AMBIGUOUS`）。
- 每个写命令成功后输出新的 `rev`。
