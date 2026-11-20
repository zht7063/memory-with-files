# 设计树：未决问题

讨论按轮进行。每轮只问"前置决策都已确定"的问题；确定后写成 ADR 并从这里移除。未回复的问题视为接受推荐答案。

- 第 1 轮 → ADR 0001–0007
- 第 2 轮 → ADR 0008–0015
- 第 3 轮 → ADR 0016–0022
- 第 4 轮 → ADR 0023–0031、[cli.md](cli.md)

## 第 5 轮（进行中）

| # | 问题 | 推荐 | 依赖 |
| --- | --- | --- | --- |
| R5-1 | frontmatter 语法 | YAML `---` 块，只支持我们用到的子集（标量字符串、`[a, b]` 列表），在 `mwf-domain` 手写解析与渲染，不引 YAML 库 | 0017, 0027 |
| R5-2 | 链接语法与悬空链接 | `[[slug]]` 与 `[[slug\|显示文字]]`；链接到不存在的页面允许写入但在输出中警告，lint 记 warning | 0016, 0017 |
| R5-3 | 读写一致性与锁等待 | 读命令不加锁（原子 rename 保证读到完整文件）；写命令等锁最多 2 秒，超时 `LOCK_TIMEOUT` | 0013 |
| R5-4 | 大小限制 | 单页正文 ≤ 100 KB；`patch` 的 old/new 各 ≤ 100 KB；stdin 读取上限 1 MB | 0023 |
| R5-5 | 会话状态存放 | `.mwf/.state/<session_id>.json`（不进 git）；每次 hook 顺带清理 7 天前的文件 | 0030 |
| R5-6 | 相关性阈值 | 命中的不同查询词（去停用词后）≥ 2 个才算相关，再按 BM25 排序；`config.toml` 的 `[hooks]`：`recall_min_terms = 2`、`recall_top_k = 3`、`stop_reminder = true`、`session_start_max_chars = 8000` | 0011, 0030 |
| R5-7 | lint 规则与级别 | error：frontmatter 不合法、slug 与文件名不符、存量 secret；warning：悬空链接、孤立页（无入链）、active task 30 天未更新、`index.md` 过期 | 0016, 0025, 0027 |
| R5-8 | skill 组织 | 一个 `mwf` skill：SKILL.md（何时读、何时写、wiki 维护原则、task 交接约定）+ `references/commands.md`；不再做斜杠命令 | 0008, 0023, 0028 |
| R5-9 | lifecycle 安全 | 改宿主文件前备份；幂等；卸载只删带 `mwf hook` 标记的条目；`--dry-run`；拒绝经符号链接写入 | 0031 |
| R5-10 | hook 命令里的可执行路径 | 写 `mwf`（依赖 PATH）；`install` 时检查 PATH 上的 `mwf` 就是当前二进制，否则写当前二进制的绝对路径并提示 | 0004, 0031 |

## 后续轮次（等待前置决策）

- **实施阶段划分、v2 成为默认分支的时机、何时删除 rust-rebuild** → `implementation-plan.md` ← 以上全部
- **每个 crate 的公开 API** → `docs/crates/*.md` ← 以上全部
