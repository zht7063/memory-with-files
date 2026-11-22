# 0049 `mwf-app` 的默认值：错误码、上限、`index`、相似度门槛

- 状态：已接受（2026-11-22）；细化 [0023](0023-write-commands-and-rev.md)、[0025](0025-secret-scanning.md)、[0026](0026-delete-to-trash.md)、[0033](0033-consistency-and-limits.md)、[0035](0035-lint-rules.md)、[0038](0038-markdown-links.md)、[0040](0040-llm-wiki-workflow.md)、[0043](0043-errors-and-clock.md)

## 背景

P2 实现 `mwf-app` 时，下列细节在已有 ADR 中没有规定。

## 决定

### 错误码

在 [cli.md](../cli.md) 的表上增加（全部退出 1）：

| code | 含义 |
| --- | --- |
| `INVALID_PAGE` | 要读或改的页面文件本身不合法（不是 UTF-8、frontmatter 解析失败）；提示运行 `mwf lint`。与 `INVALID_FIELD`（本次输入不合法）区分 |
| `INVALID_CONFIG` | `.mwf/config.toml` 不合法（`StoreError::Config`）。信息是固定文本，不转述 TOML 解析器的原因（它可能引用被拒绝的值）。目前只有 `lint` 读配置并把它记为 error；`config.toml` 是目录、符号链接或读取失败时 lint 返回对应错误码（`WRONG_FILE_TYPE` 等），不记为 `invalid_config`。P3 的 hooks 读配置时用这个码 |
| `TOO_LARGE` | 正文或 `patch` 的 old / new 超过 100 KB |
| `CHANGED` | `.mwf` 或 `.mwf/.lock` 在使用中被替换（0048） |
| `WRONG_FILE_TYPE` | `.mwf/` 下的路径是符号链接或类型不对（0048） |
| `IO` | 其他文件系统错误；时钟超出 9999 年也归入此类 |

`StoreError` 的其余变体按 [mwf-store.md](../crates/mwf-store.md) 映射。`AppError` 序列化为 `{code, message, details}`，`details` 是结构化字段（slug、路径、rev、入链列表、secret 的规则 / 行号 / 打码样本……），没有时省略。信息与 details 从不包含被拒绝的输入或 secret 原文。

### 100 KB 上限

- 上限是 102400 **字节**（UTF-8），针对正文；frontmatter 不计。
- `new`、`write` 检查输入正文；`patch` 检查 old、new，再检查替换后的正文。超限为 `TOO_LARGE`，什么都不写。
- stdin 的 1 MB 流式上限属于 `mwf-cli`。

### `index`

- `mwf index`（不带 `--rebuild`）打印**由当前页面渲染**的目录，不读 `index.md`：后者可能因合并或手改而过期。
- `--rebuild` 取写锁，内容不同时原子替换 `index.md`，输出同上；它不是页面写入，不追加 `log.md`。

### 写入

- **先检查、后改动**：取锁后、第一次改动前，读一遍全部页面文件、`index.md` 与 `log.md`，任何一个是符号链接或类型不对（如 `pages/` 下名为 `x.md` 的目录）时命令直接失败，什么都不写。`trash/` 无法预读，所以 `delete` 先把页面移入 trash，成功后才改写入链页面。
- **slug 也做 secret 扫描**：slug 会成为文件名并写入 `index.md`、`log.md`，`new` 与 `rename` 的目标 slug 命中 secret 规则时 `SECRET_DETECTED`，错误不回显 slug。
- **生成物与诊断不复制密钥**：页面本身不被改写（存量密钥留给用户删除，页面仍可 `rename` / `delete`），但 mwf 不把它搬到别处：
  - `index.md`（写入、`index`、`index --rebuild` 与 lint 的一致性检查用同一份渲染结果）：slug 命中 secret 规则的页面不列出；标题、summary 命中时分别改为 `[title withheld: looks like a secret]`、`[summary withheld: looks like a secret]`。
  - `log.md`：命中的标题同上替换；命中的 slug（含 `rename` 的源 slug）写作 `slug-withheld`。
  - 错误信息与 details、写入警告、lint 的 `page` 字段与信息：命中的 slug 显示为 `[slug withheld: looks like a secret]`；`NOT_FOUND` 对不存在的 slug 同样如此。store 错误的信息或路径命中时，只保留错误码。
  - lint 对命中的文件名报 `secret`（error）。
- **改写也受 100 KB 限制**：`rename` 与 `delete --unlink` 改写的每个正文（含页面自身的自链接）在第一次改动前检查上限，超限为 `TOO_LARGE`。
- secret 扫描比较整个页面文件（含 frontmatter）的前后文本，行号是页面文件的行号。
- 结果与原页面完全相同的 `set` / `archive` / `unarchive` / `patch` / `write` 不写文件、不改 `updated`、不记日志，`WriteOut.changed = false`。
- `new` 的 tags 去重并保持顺序；`set` 的 `--tag` 追加在已有 tags 之后，同一个 tag 既加又删、或一个字段都不给，为 `INVALID_FIELD`。
- `rename` 改写其他页面与页面自身中指向旧 slug 的内部链接；被改写的页面 `updated` 更新，整次操作只记一行 `rename`。`delete --unlink` 同理（只记一行 `delete`）。
- 不合法的页面文件不参与链接图：它们的链接不算入链（不阻止 `delete`），`rename` / `delete --unlink` 也不改写它们，而是给出 `invalid_page_skipped` 警告。不合法的页面可以 `delete`（日志行的标题为空），其他写操作返回 `INVALID_PAGE`。
- `WriteOut` 比草案多两个字段：`changed`，与 `also_updated`（同一命令改写的其他页面）。

### 摄入辅助：`related_unlinked`

用写入后的页面全文（标题、summary、tags、正文）对全部 `active` 页做 `similar_to`，排除页面自身与它已经链接的页面，只保留与它共享至少 2 个不同词（`RELATED_MIN_TERMS`，与 `recall_min_terms` 默认值一致）的页，取前 3 页。

### lint

- 规则名：`invalid_slug`、`invalid_frontmatter`、`secret`、`stale_task`（来自 `mwf_domain::validate`），`dangling_link`、`orphan`、`index_drift`、`possible_duplicate`，以及 error `invalid_config`。不是 UTF-8 的页面文件记为 `invalid_frontmatter`，同时照常检查文件名（`invalid_slug`），并对按 lossy 解码后的文本做 secret 扫描。
- `orphan` 只报 `active` 页；自链接不算入链。
- `index_drift`：`index.md` 缺失或与渲染结果的字节不同。
- `possible_duplicate`：对每个 `active` 页，用它的全文做 `similar_to`（取前 6 个候选）；若另一页的分数 ≥ 最高分（通常是页面自身）的 0.8（`DUPLICATE_SIMILARITY`），这两页记为可能重复，两页各报一条 warning；信息只给对方的 slug，不给标题（存量标题可能含密钥）。BM25 分数随语料漂移，相对自身分数的比例比固定分数稳定。0.8 的依据：内容几乎相同的两页约为 0.9，同主题、不同内容的页约为 0.1。
- 时间取自注入的 `Clock`；lint 从不写文件。
- 性能：5000 页（每页约 0.5 KB）在 4 vCPU 的 orb 上，release 构建的 `lint` 约 2.2 s，主要花在 `possible_duplicate` 上；单次写入约 90 ms。lint 是手动命令，可以接受；P3 的 SessionStart 不应调用完整的 lint。

### `mwf-assets`

`init` 写入 `.mwf/` 的文件（`config.toml`、`.gitignore`）由 `mwf-store` 解析与写入，store 不能依赖 assets（拓扑图），所以留在 store。assets 在 P2 只提供 `init` 成功后给人看的下一步提示（git / `--local` 两种）；skill 与 hook 文本在 P3 加入。
