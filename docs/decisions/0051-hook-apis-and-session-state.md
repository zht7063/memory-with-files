# 0051 hooks 的事件、注入内容、预算与会话状态

- 状态：已接受（2026-11-22）；细化 [0024](0024-bypass-guard.md)、[0030](0030-hooks-behavior.md)、[0034](0034-session-state.md)、[0039](0039-bm25-scoring-and-relevance.md)、[0040](0040-llm-wiki-workflow.md)、[0049](0049-app-defaults.md)

## 背景

P3 实现 hooks 前，下列细节在已有 ADR 中没有规定或彼此不一致：事件的命令名、`mwf-hooks` 的入口签名、SessionStart 注入什么与按什么顺序（0030 说注入 `index.md`，0040 说先 preference 正文再按类型注入目录行）、注入内容怎样隐去密钥、Stop 提醒的输出形式与“每轮一次”、预算数字、失败时输出什么、会话状态文件的格式、项目根与 PreToolUse 路径怎样解析。

已查证的宿主事实（2026-11-22，code.claude.com/docs/en/hooks 与 developers.openai.com/codex/hooks）：

- 两个宿主的输入都有 `session_id`、`cwd`；Claude 另有 `prompt_id`（当前用户 prompt，首个输入前缺失），Codex 的 UserPromptSubmit / Stop 有 `turn_id`。Stop 都有 `stop_hook_active`。SessionStart 的 `source` 为 `startup` / `resume` / `clear` / `compact` / `fork`。
- Claude 的 Stop 接受 `hookSpecificOutput.additionalContext`（标为 hook feedback，不算 hook 错误）或 `decision: "block"`；Codex 的 Stop 只有 `decision: "block"` + `reason`（`reason` 成为续写的 prompt），且 exit 0 时必须输出 JSON。
- Claude 的 `additionalContext` 超过 10000 字符会被换成文件路径；Codex 超过 `additionalContextLimit`（约 2500 token）时同样落盘、只给预览。两者的 command hook 默认超时 600 s（Claude 的 UserPromptSubmit 为 30 s）。

## 决定

### 命令与入口

- 事件名：`mwf hook session-start|prompt|stop|pre-tool --host claude|codex`，分别对应 SessionStart、UserPromptSubmit、Stop、PreToolUse。
- `mwf_hooks::run(args: Vec<OsString>, io: &mut Io) -> ExitCode`：`args` 是 `hook` 之后的参数（`["session-start", "--host", "claude"]`），`Io` 与 `mwf-cli` 同形（stdin / stdout / stderr 三个 trait 对象）。恒返回 `ExitCode::SUCCESS`。bin 看到第一个参数为 `hook` 时交给它。

### 项目根

- 项目从宿主 JSON 的 `cwd` 向上查找（`App::open(cwd)`）；`cwd` 缺失、不是字符串或不是绝对路径时用进程的当前目录。Claude 进入 worktree 或 `cd` 后，`cwd` 跟随它，进程目录不一定。
- 找不到 `.mwf/`（`NOT_INITIALIZED`）时什么都不做，输出 `{}`（0030）。

### SessionStart

`App::session_context(max_chars) -> SessionContext { text, truncated }`，按顺序：

1. `## Preferences`：每个 active `preference` 页一节 `### <标题> (<slug>)` + 正文，按 slug 排序（0040：约定写成 preference，总会注入）。
2. `## Directory`：每个 active 页一行 `- <slug>: <标题> — <summary>`，按 `PageType::ALL` 的类型顺序分组（`### <type>`）、组内按 slug。**由当前页面渲染**，不读 `index.md`（与 `mwf index` 一致，0049：`index.md` 可能因合并或手改而过期）。取代 0030 的“注入 `index.md`”。
3. `## Recent changes`：`log.md` 最后 10 行（`SESSION_LOG_LINES`）。
4. lint 计数行：`lint: N errors, M warnings; run `mwf lint` for details`，只在有问题时出现。运行除 `possible_duplicate` 以外的全部规则：后者每页一次 BM25 查询，5000 页时 lint 约 2 s；去掉它后 5000 页（每页约 0.5 KB）的整个 `session_context` 约 90 ms（release，4 vCPU）。重复页留给手动 `mwf lint`。

预算与截断：

- `max_chars` 按字符（Unicode 标量，含换行）计，取自 `session_start_max_chars`（默认 8000）。
- 放不下时先为 lint 行预留空间（它单独放得下就一定完整保留），再在剩余预算内从 1–3 的末尾按**整行**丢弃，在断开处放一行提示：断在 preference 中为 ``[mwf: truncated; run `mwf list --type preference` and `mwf show <slug>` for the other preferences, `mwf index` for the directory]``，断在某类型的目录行中为 ``[mwf: truncated; run `mwf index` for the whole directory or `mwf list --type <type>` for this type]``，断在日志中为 ``[mwf: truncated; run `mwf log` for recent changes]``。`truncated = true`。剩余预算放不下提示时只保留放得下的整行、不加提示；只有 lint 行本身比 `max_chars` 还长时才把它截到 `max_chars`。
- 空项目（无页面、无日志、无问题）返回空文本，hook 输出 `{}`。

`source`：

- `startup`、`resume`、`fork`：照常注入；会话状态不动（`resume` 的上下文仍含此前的 recall）。
- `clear`、`compact`：先 `App::reset_session(session_id)` 删除该会话的状态文件，再注入：此前注入的内容已不在上下文里，recall 应重新可用。

### UserPromptSubmit

`App::recall(session, prompt) -> Vec<PageSummary>`：

- prompt 分词去停用词后不同的词少于 2 个（`RECALL_MIN_PROMPT_TERMS`）时返回空（0039 第 3 条；与 `recall_min_terms` 无关，`recall_min_terms = 1` 也不放行单词 prompt）。
- 只在 active 页上做 BM25（`Index::search`），保留 `matched_terms >= recall_min_terms` 的页，去掉本会话已注入过的，取前 `recall_top_k`。`recall_top_k = 0` 时直接返回空。
- 返回的页记入会话状态（只在非空时写文件）。session id 没有安全字符（缺失、为空）时不去重、不写状态。
- 注入内容是 slug、标题、summary（0030），**不带 rev**：rev 用于 `write`，agent 应在改页前 `mwf show` 取最新的 rev；DTO 里仍有 `rev` 字段（与 `list` 相同），由 hooks 决定不渲染。
- `mwf-hooks` 跳过用户自己输入的 `/mwf` 命令行（`^\s*/mwf([\s:-]|$)`）：skill 自己会调用 `mwf`，再注入是重复。

### 隐去密钥

注入内容与 `index.md` 同样不复制密钥（0049）：slug 命中 secret 规则的页面在 SessionStart 与 recall 中都不出现；标题、summary 命中时为 `[title withheld: looks like a secret]`、`[summary withheld: looks like a secret]`；preference 正文命中时整段换成 ``[body withheld: looks like a secret; run `mwf lint`]``；日志行命中时为 `[log line withheld: looks like a secret]`。lint 计数行会让用户看到 `secret` error。

### Stop

- `App::stop_reminder(session, turn) -> bool`：`stop_reminder = false` 时恒为 false；否则同一会话同一 turn 只返回一次 true，turn 记在会话状态的 `reminded_turn`。turn 是 Claude 的 `prompt_id`、Codex 的 `turn_id`。session id 或 turn 缺失时返回 true（仍由下一条防循环）。
- `stop_hook_active == true` 时 `mwf-hooks` 直接输出 `{}`，不调用 app：防止提醒 → 续写 → 再提醒的循环。
- 输出：Claude 用 `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":…}}`（不算 hook 错误，同样受 `stop_hook_active` 与 8 次上限保护）；Codex 只能用 `{"decision":"block","reason":…}`。提醒文本来自 `mwf-assets`，内容按 0040 的摄入流程。

### PreToolUse

- `App::is_inside_mwf(cwd, path) -> bool`：`path` 相对时以 hook 输入的 `cwd` 为基准；处理 `.`、`..`，并逐段跟随**已存在的**符号链接（含悬空链接、以及尚不存在的目录之下的链接，最多 40 层，与 Linux `MAXSYMLINKS` 相同）；链接成环时停止跟随。之后只要任何一段名为 `.mwf` 就算在内。大小写不敏感的卷（macOS 的 APFS / HFS+ 默认如此）上 `.MWF` 指向同一个目录，所以还比较**身份**：路径中已存在的每一段，与本项目 `.mwf` 的（设备号, inode）相同，或名字按 ASCII 忽略大小写等于 `.mwf` 且与同一父目录下 `.mwf` 的身份相同，都算在内。大小写敏感的卷上，真实存在的 `.MWF` 是另一个普通目录，不算。
- 不是“最近存在祖先 canonicalize”：那样会漏掉指向 `.mwf/pages/missing.md` 的悬空链接与 `link/new-dir/x.md`。
- 判断**任何** `.mwf`，不只本项目的：嵌套项目、另一个 checkout 的 `.mwf/` 同样只能经由 `mwf` 写（0016）；误拦的代价（agent 改用 `mwf` 命令）低于漏拦。
- 守卫在 `.mwf/` 存在的项目里才运行（0030）；shell 命令的尽力检测与 apply_patch 解析在 `mwf-hooks`（0024）。

### 预算

| 项目 | 值 |
| --- | --- |
| 内部截止时间 | 从进程开始 3 s：每一步之前检查，超时即放弃剩余的可选工作，输出已有结果（没有则 `{}`）。store / app 调用是同步的，无法中途打断，所以截止时间远低于宿主超时 |
| hook 不取写锁 | 读不加锁（0033）；会话状态每会话一个文件、不加锁（0034） |
| stdin 上限 | 1 MiB（与 CLI 的 `STDIN_MAX_BYTES` 相同），流式计数，超出视为坏输入 |
| 输出上限 | 每次 `additionalContext` 最多 9800 字符（低于 Claude 的 10000），**包住数据的外壳在截断之前预算**：`mwf-hooks` 先生成随机 fence 与说明行，算出外壳（开头说明、开 fence、闭 fence 及换行）的长度，数据预算 = min(`session_start_max_chars`, 9800 − 外壳长度)，用它调用 `session_context`，再把结果放进外壳。包好之后不再截断，闭 fence 永远不会被切掉（0030）。recall 同样：外壳之外按整页（每页一行）放入前 `recall_top_k` 页，放不下的页整页丢弃。外壳本身超过 9800 时（不会发生，测试固定）不注入 |
| 宿主超时（P4 写入安装配置） | 10 s，四个事件相同，远大于 3 s 的内部截止时间 |

### 失败与坏输入

所有情况都退出 0，stdout 恰好一行 JSON 对象：

- 未知事件、未知 `--host`、参数错误、stdin 不是 JSON 对象或超限：stdout `{}`，stderr 一行 `mwf hook: …`（宿主只在调试时显示）。
- 没有 `.mwf/`：`{}`，stderr 为空。
- SessionStart / UserPromptSubmit 上的 app 错误（含 `INVALID_CONFIG`、`WRONG_FILE_TYPE`、`CHANGED`、`IO`）：`{"systemMessage":"mwf: <event> hook skipped (<CODE>); run `mwf lint`"}`，让用户知道记忆没有注入；信息只含错误码，不含路径（路径可能含疑似密钥的 slug）。
- Stop、PreToolUse 的任何错误：`{}`。PreToolUse 出错时放行（护栏不是安全边界，0024），不让坏配置挡住所有编辑。

### 会话状态（`mwf-store`）

- 路径 `.mwf/.state/<id>.json`；`.state/` 在第一次保存时创建（fsync `.mwf/`），与 `pages/`、`trash/` 一样检查文件类型、不跟随符号链接、核对 `.mwf` 句柄（0048）。
- `id` 只保留 ASCII 字母、数字、`-`、`_`，最多 128 个；什么都不剩（缺失、空、`..`、非 ASCII）时 `Project::session` 返回 `None`，调用方不去重、不写状态。宿主的 id 是 UUID，不受影响。
- 格式：`{"version":1,"recalled":[slug…],"reminded_turn":string|null}` 加换行；未知键忽略，缺键取默认。
- 文件不存在、不是 JSON、形状不对或 `version` 不是 1 时读作空状态（状态只用来避免重复注入，丢失的代价是重复一次），下次保存覆盖它。`.state` 或状态文件是符号链接 / 类型不对时为 `WRONG_FILE_TYPE`，与其他 `.mwf/` 路径一致。
- 保存是原子写（临时文件 + fsync + rename），不取 `.mwf/.lock`。
- 清理：每次打开会话（recall、Stop 提醒）时删除 `.state/` 中**修改时间**早于“现在”7 天及以上的普通文件（含中断的写入留下的临时文件）；符号链接与目录不动；修改时间晚于现在的不删。用 mtime 而不是文件内记录的时间：损坏的文件也能清理，每次保存自然刷新。“现在”取 app 的 `Clock`。清理失败被忽略（它是可选的维护），随后的读写会报告真正的问题。

## 后果

- [crates/mwf-store.md](../crates/mwf-store.md) 记录 `Project::session`、`SessionStore`、`SessionState`、`prune_sessions`；[crates/mwf-app.md](../crates/mwf-app.md) 记录 `hooks_config`、`session_context`、`recall`、`stop_reminder`、`reset_session`、`is_inside_mwf`（比草案多一个 `cwd` 参数）；[crates/adapters.md](../crates/adapters.md) 记录 `mwf_hooks::run` 的签名、事件名与预算；[cli.md](../cli.md) 记录事件名与输出约定。
- 0030 的“注入 `index.md`”改为由页面渲染的目录行；其余行为不变。
