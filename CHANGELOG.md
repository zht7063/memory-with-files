# Changelog

## 1.0.0-alpha.0 (unreleased, `v1` integration branch)

### 破坏性变更 / Breaking

- 从零重写，不复用也不迁移 0.x 代码、`.mwf/` 数据或集成回执。新的分层目录为 `src/core`、`src/cli`、`src/mcp`、`src/hooks`（另有纯文本的 `src/skills`）；目前已实现 `src/core`、`src/cli`、`src/mcp` 与 `src/hooks`（尚无 install）。
- Rewritten from scratch: no 0.x code, data or receipt migration. Layered layout `src/core`, `src/cli`, `src/mcp`, `src/hooks`; `core`, `cli`, `mcp` and `hooks` are implemented so far (no install yet).

### 新增 / Added

- PR4a hooks 层 / hooks layer（不含安装）：`mwf hook <session-start|prompt|stop>`（Codex 命令 hook，stdin 为宿主 JSON，stdout 一行 JSON，**永远退出 0**，不需要终端、从不 `--confirm`）；`src/hooks`（handlers、fence、Codex 适配器、监督进程 runner/worker、预算常量）、`src/skills`（技能与快捷命令文本的唯一来源：`mwf`、`mwf-save`、`mwf-handoff`、`mwf-tidy`；init/status/recall/save/handoff/tidy）、`./hooks` 包导出；cli 新增 `getSession` / `setSession`，`src/mcp/index.ts` 把它们与 `confirmHost` 作为宿主辅助函数（不是工具）导出；`state.toml` 的 session 条目新增 `stop_turn` 并保留未知字段；`status` 返回 `hooks.stop`，项目可用 `[hooks] stop = false` 关闭 Stop。不写任何用户配置、不含 install。 / `mwf hook <event>`: always exit 0, no terminal, never `--confirm`; `src/hooks`, `src/skills`, the `./hooks` export; cli `getSession` / `setSession`, re-exported with `confirmHost` from `src/mcp/index.ts` as host helpers (not tools); `stop_turn` in the session entry (unknown fields preserved); `status` reports `hooks.stop`. No user-config writes, no install.
- Aegis（PR4a 验收）：① **注入围栏**：每次调用生成 96 位随机分隔符（`<<<MWF-DATA-<nonce>` … `MWF-DATA-<nonce>>>>`），数据里的控制/双向字符被清除、`MWF-DATA` 与 `<<<`/`>>>` 被改写，召回文本无法提前闭合围栏；注入有字符上限（session-start 8000、prompt 4000），按行截断并在围栏外写明 `[mwf: truncated, N more characters were left out …]`。② **Stop 防循环**：宿主 `stop_hook_active` 必须恰为 `false`，**并且**通过 `setSession({claim_stop_turn})` 在锁内原子地认领本回合（`state.toml` 的 `stop_turn`，走 `runWrite` 的同一写入路径：锁、intent、原子写、dedup）；任一无法读取（缺字段、类型不对、状态文件损坏、锁忙、无 session）即放行、不继续；同一回合第二次一定放行；并发的三个认领只有一个成功。③ **4.5 秒预算含锁等待**：所有 hook 锁等待 200 ms（读路径锁忙时直接用现有索引并标注可能过期，不恢复、不等待；写入锁忙则放弃），顺序 锁等待 < 2.5 s 软限（之后不再做可选写入）< 4 s 监督进程 SIGKILL < 5 s 宿主 timeout，三个事件同一预算；0.x #33（Stop 的 15 s 宿主超时与 14.5 s 自杀互相打架）由此消除：没有任何路径会因等锁被宿主杀掉，被杀的工作进程若已输出答案则答案仍被送达。④⑤⑥（符号链接安全写入、保留未知字段、唯一备份名、并发修改拒绝、install/uninstall 仅 TTY）属于 4b/4c；本 PR 的 state.toml 已保留未知字段，且没有任何 hook 写用户配置。 / Aegis: (1) per-invocation random fence + cleaned data + cap with an explicit truncated note; (2) Stop continues a turn only when the host says `stop_hook_active: false` AND an atomic claim under the lock via the normal write path succeeds; anything unreadable, busy or missing allows the stop; (3) lock waits 200 ms, busy reads serve the existing index, order lock waits < 2.5 s < 4 s kill < 5 s host timeout for every event (the 0.x #33 conflict is gone). Items 4–6 belong to 4b/4c.
- 设计决定（yubai，PR4 计划 15 点，按推荐）/ Decisions (PR4 plan, 15 points as recommended)：三个 hook 点、不做 compact hook；hook 只能经 MWF 写入路径写；入口文本经 hook 与 skill 提供，不写 AGENTS.md；`mwf hook` 只服务 Codex，Pi 用生成的进程内扩展（4c）；session 映射在 `state.toml`，宿主加载在 `host.local.toml`；install 只写用户级配置、卸载无状态靠标记、install/uninstall 仅 TTY（4b/4c）。已知风险：`stop_hook_active` 必须是布尔 `false`，若宿主省略该字段 Stop 永远放行，需在 4b 真机确认；Codex 输出格式在 4b 之前未经真机验证。 / Known risks: `stop_hook_active` must be exactly `false` (a host that omits it never gets a Stop continuation; confirm in 4b); Codex output formats are unverified on a real host until 4b.
- PR3 MCP 层 / MCP layer：`src/mcp` 把 16 个 CLI 函数暴露为 `mwf_<name>` 工具，`mwf mcp` 通过 stdio 提供服务（`@modelcontextprotocol/server` 2.4.0，精确锁定；低层 `Server` + `serveStdio`，错误沿用 CLI 的 `{ok,error}` 包络）；结果为文本加 `structuredContent`，失败带 `isError`、`retryable` 与 `hint`；工具不接收项目路径，自服务器工作目录（或 `--cwd`）向上查找 `.mwf/`；同一服务器的写入串行执行；首次工具调用后登记宿主（`--host`，否则取客户端名）；不捕获 SIGTERM，写入中途被杀留下的锁与 intent 由下一个进程恢复。 / MCP tools `mwf_<name>` for the 16 CLI functions, `mwf mcp` over stdio (SDK 2.4.0 exact pin, low-level `Server`, CLI envelope kept); text + `structuredContent`, `isError` / `retryable` / `hint` on failure; no project path argument; serialized writes; host registration after the first call; SIGTERM not trapped (the next process recovers lock + intent).
- 设计决定（yubai，PR3）：① 破坏性操作（forget、purge、compact、inbox discard）经 MCP 只预览、从不执行；MCP 工具不接收 `confirm` / `preview_token`，预览返回 `preview_token` 与 `execute_with`（用户要在 shell 里运行的命令）。② shell 因此开放 `forget`、`purge`、`compact`、`inbox`（list/accept/discard）：不带 `--confirm` 只预览并打印 token；`--confirm` 必须带 `--preview-token`，在锁内重新校验哈希（`PREVIEW_MISMATCH`）；只有 `--confirm` 报 `CONFIRM_REQUIRES_TOKEN`，不删除任何东西。③ `request_id` 的生成移入 `cli.run`（shell、MCP、hooks 共用，失败时在 `error.details.request_id` 回报；预览不带）。④ 项目根 = 运行 `init` 的目录，且其中必须有 `.git`：在仓库子目录或没有 `.git` 时 `init` 拒绝（`NOT_GIT_ROOT`）、说明原因、不写任何文件；其他命令与 MCP 向上查找 init 创建的 `.mwf/`。⑤ `recall` / `status` / `bootstrap` / `get` 的 MCP 描述注明“不改变记忆内容，但可能取锁并写 `.mwf/`”。 / Decisions (yubai, PR3): destructive tools only preview over MCP (no `confirm` / `preview_token`; the preview carries `execute_with`); the shell gains `forget`, `purge`, `compact`, `inbox` with the two-step `--confirm --preview-token` flow (bare `--confirm` is refused with `CONFIRM_REQUIRES_TOKEN`, the token is re-verified under the lock); `request_id` generation moved into `cli.run`; `init` only at a git repository root (`NOT_GIT_ROOT`, nothing written), other commands walk up to the `.mwf/`; read tools' descriptions say they may take the lock and write `.mwf/`.
- 设计决定（yubai，10-30）：shell 的破坏性 `--confirm`（forget、purge、compact、inbox discard）只能由用户本人在交互式终端执行：`process.stdin.isTTY` 与 `process.stdout.isTTY` 必须同时为真，否则返回新错误码 `CONFIRM_REQUIRES_TTY`（退出码 1，消息要求用户自己在终端里运行），在读取记忆或取锁之前拒绝，不删除任何东西；预览（不带 `--confirm`）不受影响。管道（`echo y | mwf forget … --confirm …`）、重定向、脚本和 agent 的 shell 工具因此都无法确认。测试用 `main` 的 `Io.tty` 参数注入，没有环境变量或标志可以绕过。MCP 的 `execute_with` 说明改为“用户在自己的终端里运行”，去掉了“或经宿主审批”的说法。已知限制：agent 可借 `script` 或伪终端（pty）获得 TTY，所以这只防止 agent 误执行，不防止有意绕过。 / Decision (yubai): a destructive shell `--confirm` (forget, purge, compact, inbox discard) runs only for the user in an interactive terminal: stdin AND stdout must both be TTYs, else the new error `CONFIRM_REQUIRES_TTY` (exit 1; the message tells the user to run it themselves in a terminal) is returned before any memory is read or the lock is taken, and nothing is deleted; previews are unaffected. Pipes (`echo y | mwf forget … --confirm …`), redirects, scripts and an agent's shell tool cannot confirm. Tests inject `Io.tty` as an argument; no environment variable or flag overrides it. The MCP `execute_with` note now says the user runs it in their own terminal (the "or after host approval" wording is gone). **Known limitation:** an agent can obtain a TTY with `script` or a pseudo-terminal (pty), so this only prevents accidental agent execution, not deliberate circumvention.
- SDK 注意（Aegis L1）：MCP 层使用 SDK 的低层 `Server`（类型里标为 deprecated，建议用 `McpServer`；我们选低层是为了沿用 CLI 的 `{ok,error}` 错误包络和自己的 JSON Schema 校验），`@modelcontextprotocol/server` 精确锁定在 2.4.0；升级 SDK 时可能需要迁移（`Server` → `McpServer`），升级前先跑 `tests/mcp.test.ts`。 / SDK note (Aegis L1): the MCP layer uses the SDK's low-level `Server`, which is `@deprecated` in the SDK's types (it recommends `McpServer`); we use it to keep the CLI's `{ok,error}` envelope and our own JSON-Schema validation. `@modelcontextprotocol/server` is pinned to exactly 2.4.0 and may need a migration (`Server` → `McpServer`) when the SDK is upgraded; run `tests/mcp.test.ts` first.
- 测试 / Tests: `--confirm` 无终端被拒且不删除、stdin 与 stdout 各自单独检查、真实进程用管道（`echo y | …`、`yes | …`、`< /dev/null`）被拒、真实伪终端里可执行（有 `script` 时）、预览无需终端；MCP 上非数字 `wait_ms` 被 schema 拒绝（Aegis L2）。 / `--confirm` refused without a terminal and nothing deleted, stdin and stdout checked independently, real piped processes refused, executes in a real pty (where `script` exists), previews need no terminal; a non-numeric `wait_ms` is rejected over MCP (Aegis L2).
- 测试辅助 / Test hook：`MWF_FAILPOINT_STALL=<ms>` 让 failpoint 打印 `failpoint-stalled <name>` 并阻塞，而不是 SIGKILL，供 SIGTERM 测试使用。 / `MWF_FAILPOINT_STALL` stalls at a failpoint instead of SIGKILL, for the SIGTERM test.

- PR2 CLI 层 / CLI layer：`src/cli` 为每个命令提供一个结构化函数（init、bootstrap、recall、get、add、propose、edit、handoff、status、doctor、inbox、compact、reindex、forget、restore、purge；MCP 层日后映射为 `mwf_<name>`），输入按 JSON Schema 子集校验（拒绝未知字段），自 `cwd` 向上查找项目，返回 `{ok,data}` / `{ok:false,error:{code,message,details}}`，永不抛出；`mwf` 可执行文件（`src/bin`，只分发）仅开放只读的 `status` / `recall` / `doctor`（`--json`、`--cwd`；退出码 0 成功、1 失败或 doctor 报错、2 用法错误），写操作只走 MCP；`hook` / `mcp` / `install` / `uninstall` / `update` 不在本次构建内。`tests/layers.test.ts` 强制各层只依赖紧邻的下一层。`package.json` 新增 `bin` 与 `./cli` 导出。
- 设计决定（yubai，18:41 SGT）：`recall --handoffs` 忽略 `--scope`，handoff 不按 scope 过滤（仍按 query 与 status 过滤，排在匹配的记录之后）；在 core 实现，CLI 与 MCP 一致；多维度 scope 规则保持不变。 / Decision (yubai): `recall --handoffs` is never scope-filtered (core, so CLI and MCP agree); the multi-dimension scope rule is unchanged.
- 修复（Aegis）：`recall` 在 scope 过滤之前就把候选截断到 200 条，`--scope` 可能漏掉靠后的匹配；现在先按 scope 过滤再截断（无 scope 时仍最多 200 个候选）。shell 的 stdin（`--body-file -`）改为边读边按字节计数，超过 1 MB 立即中止（退出码 2），不再读完再检查。 / Fixes: `recall` applies the scope filter before the 200-candidate cap; stdin is counted while streaming and aborted as soon as it passes 1 MB.
- 设计决定（yubai，PR #38）：① `mwf` shell 另外开放 `add` 与 `handoff`（read / save）：参数或 stdin（`--body-file -` / `--content-file -`）输入，`--json`，退出码约定不变（0 成功、1 失败含秘密扫描拒绝、2 用法或无效输入）；走与 MCP 相同的 core 写入路径（秘密扫描、request_id 幂等、handoff 版本检查），shell 始终发送并打印 request_id（失败时也打印，`--json` 在 `error.details.request_id`）；其他写操作仍仅 MCP。② `recall --scope` 只返回 scope 匹配的记录（无 scope 的记录不再返回）：在 core 的 `scopeMatch` 统一修改，shell、CLI 函数与 MCP 行为一致；没有 `--scope` 时不过滤。③ `lockHeldWarnMs` 默认值保持 120 秒。④ `LOCK_LOST` 对该次调用是终止性的，调用方用同一个 request_id 重试，写入恰好生效一次（readme、`--help` 已说明）。
- Decisions (yubai, PR #38): the shell also exposes `add` and `handoff read|save` (flags or stdin, `--json`, same exit codes, same core write path incl. secret scan and request_id idempotency; the shell always sends and prints a request_id); `recall --scope` returns only records whose scope matches (changed in core `scopeMatch`, so every layer agrees; unscoped records are no longer returned, no `--scope` means no filter); `lockHeldWarnMs` stays 120 s; `LOCK_LOST` is terminal for the call and the caller retries with the same request_id.
- CLI 文档与提示：NOT_INITIALIZED 提示改为“通过 MCP 工具 `mwf_init`（或可用时的 `mwf install`）初始化，shell 没有 init”；`mwf --help` 与 readme 说明 status/recall 可能取项目锁并写 `.mwf/` 以恢复崩溃遗留的 intent、刷新过期索引，doctor 从不取锁、不写文件。 / CLI hint and docs: not-initialized points at `mwf_init` / `mwf install`; help and readme state that status and recall may take the lock and write to recover a crashed intent, while doctor never does.
- Locking / recovery (Aegis L1–L4)：① doctor 报告“向前滚动时因文件已变化而跳过删除”（`rollforward_skipped`，记录在机器本地的 `.mwf/recovery.local.json`，30 天过期；文件消失后不再报告）；② doctor 报告锁被活着的持有者持有过久（`lock_held_long`，`lockHeldWarnMs` 默认 120 秒；锁里新增只在获取时写入的 `acquired`）；③ 记录并文档化“同主机名、不同 pid 命名空间”的容器可能误回收对方的锁：锁里记录 `pidns`（Linux `/proc/self/ns/pid`），命名空间不同的持有者按异主机处理（仅按心跳超时回收）；无法读取命名空间时（无 /proc、旧版锁）该风险仍在，见 readme「Locking」；④ 心跳发现锁已丢失时中止写入：写入在 intent 之前、每个目标之前、索引同步与 dedup 登记之前复核锁，丢失则以新错误码 `LOCK_LOST` 终止，不再写任何文件，残留 intent 由下一个持锁者恢复；定时心跳与 `beat()` 也会发现并终止。
- Aegis L1–L4 (English): doctor reports roll-forwards that skipped a changed file and locks held too long; the same-hostname / different-pid-namespace hazard is documented and mitigated where `/proc` allows; a write whose lock was lost is aborted with `LOCK_LOST`.

- 设计决定落地（core 跟进）：① request_id 去重表移到机器本地的 `.mwf/dedup.local.toml`（被 `.mwf/*.local.*` 忽略，不入库；损坏时视为空并由 doctor 警告），`state.toml` 只保留 session 映射；② `runWrite` 内置秘密扫描，写入新引入疑似秘密（API key、令牌、私钥、JWT、带口令 URL、`key = 随机值`）时以 `SECRET_DETECTED` 拒绝，不落任何文件，错误只带规则/路径/行号和打码样本；只统计新引入的匹配，已有内容仍可 forget/purge/编辑其他字段；③ `inbox discard` 与 forget/compact/purge 一致，需 preview_token + confirm（`edit` 仍非破坏性，仅哈希前置条件）；④ 每次改动记录/handoff 的写入都在同一把锁、同一 intent（先写 index.md）内更新 `index.md`。
- 恢复修复：index.md 是每个计划的第一个写入，崩溃后被丢弃的 intent 可能让它列出从未落盘的记录；现在恢复（任何非 none 的 intent 路径，含损坏的 intent）会在删除 intent 之前按磁盘上的记录重建 index.md，并且读操作在遇到“写入者已死”的遗留 intent 时不再走免锁快路径，而是先恢复；活着的写入者的 intent 不受影响。protocol.md 注明秘密扫描基于模式、并不穷尽（如 `DB_PASS=...`）。
- Decisions landed (core follow-up): dedup table moved to machine-local `.mwf/dedup.local.toml`; secret scanning inside `runWrite` (`SECRET_DETECTED`, only newly introduced matches); `inbox discard` needs preview_token + confirm; `index.md` is refreshed by every record/handoff write inside the same lock/intent/recovery flow.

- `src/core`：`.mwf/` 布局（config.toml、protocol.md、index.md、inbox.md、handoff/、memory/<五类>/、index.db、state.toml、host.local.toml、trash/）、init（git 模式 track/local）、bootstrap、recall、get、add、propose、edit（内容哈希前置条件）、handoff read/save（版本检查，冲突追加「并行更新」段）、status、doctor、inbox、compact、reindex、forget/restore/purge（30 天回收站）。
- 并发与崩溃安全：同目录临时文件 + fsync + rename + fsync 目录；O_EXCL 锁（pid/host/time/start；同主机仅在持有者 pid 确认已死、或进程启动时间不符（pid 复用，Linux 读 /proc/<pid>/stat + boot_id）时回收，活着的同主机持有者无论多久都不回收，无 /proc 的平台退化为仅 pid 存活检查；异主机持有者按心跳超时（默认 30 秒）回收并由 doctor 报告；长操作（compact/reindex/purge 等）定期心跳刷新锁时间；回收守卫文件清理前复读 token 比对）；forget/purge/compact 的多文件写入先写后删，崩溃后恢复时对已落盘的删除向前滚动，compact 的 preview_token 不含保留记录的 scope（只做幂等并集）；request_id 幂等（intent → 原子写 → 登记 dedup → 删 intent，下次加锁恢复遗留 intent）；forget/purge/compact 预览 + preview_token 确认。
- Tests: multi-process writes, kill -9 at every failpoint, dedup, reindex equivalence, lock timeout / stale reclaim, reader-during-write, preview_token, gitignore modes.

## 0.4.0

### 新增

- Codex 插件新增 `Stop` hook：每个 agent 回合结束时首次触发返回 `{decision:"block", reason}`，提示 agent 自检本回合是否有值得保存到 `.mwf/` 的 preference/decision/incident/task/knowledge（带 scope 标签），有则经 `mwf_add`/`mwf_propose` 写入，并判断本回合是否有实质进展（文件改动、任务推进），有则经 `mwf_handoff` 按 task（或会话）覆盖式保存 completed/next_action/blockers/decisions（先 read 取 revision，再以 expected_revision 保存，revision 加一），纯聊天回合跳过，均不适用则静默结束；`stop_hook_active=true`、项目未启用、超时或任何失败（含空/非法/超大输入，Stop 命令带 `--stop`）均放行；宿主缺失 `stop_hook_active` 时以 (session_id, turn_id) 本地标记兜底，同一回合只 block 一次。SessionStart/UserPromptSubmit 行为不变。
- 宿主加载确认：attach/rebind 后，首次 Codex hook（SessionStart、UserPromptSubmit 等）、首次 Pi 扩展事件（受信任项目）或首次 MCP 工具调用，会在 `.mwf/local/integration.json` 的 `clients.<host>.probe.host_confirmation.<channel>`（`hook`／`extension`／`mcp`）写入确认记录（`time`、`host_version`、`host_name`、`trigger`，外加 `binding_generation`、`runtime_version`）。记录放在自由格式的 `probe` 内，`receipt_version` 仍为 3，旧的 0.3.x 运行时（严格 schema）读取、status/doctor、detach 均不受影响。Codex 的 MCP 在 `config.toml` 中独立于 hook 信任加载，因此 MCP 调用只记 `mcp` 通道，不确认 hook；只有 `hook` 触发（或 Pi 的 `extension`）才把 `probe.host_confirmed` 由 `unknown` 置为 `confirmed`。`status` / `doctor` 在 `probed.<host>.host_load` 显示 `pending`／`confirmed`、`required` 通道与各通道状态（Codex hook 载荷无版本字段，`host_version` 取 hook 载荷（若有）或同一宿主 MCP 的 clientInfo）。attach 后至少 10 分钟仍未确认时给出 `host_load.hint` 与顶层 `hints`「可能未加载或未信任」（Codex 会注明 hook 未触发、MCP 是否已连接；仅提示，不使 doctor 失败）；计时起点取 attach 探测时间与 receipt 文件 mtime 中最早的有效值，不依赖 probe，且忽略晚于当前时间的锚点（时钟回拨）。attach/rebind 重建 `probe`，旧确认随之清空，status 与 `probe.host_confirmed` 对其他 generation／runtime_version 的记录一律视为无。首次确认在 hook／MCP 内最多等待项目锁 250 ms（`withLockDeadline`），拿不到则放弃并在下一次触发重试，永不抛错。

### 修复

- Codex hook 延迟（[#30](https://github.com/zht7063/memory-with-files/issues/30)）：o200k tokenizer 改为首次精确计量时才加载（长驻 MCP/Pi 进程加载一次后复用）；hook 路径（SessionStart / UserPromptSubmit）不再加载 tokenizer，改用不依赖 tokenizer 的保守估算（`estimateTokens`：按词法 run 计价、+10% 余量，并以字节数为硬上限；在英文/代码/JSON/空白/简繁中文/日韩/西里尔/阿拉伯/泰/印地/emoji/稀有汉字等语料上不低于 o200k 精确值，属校准估算而非证明；预算的 `tokenizer_id` 为 `approx_chars_v1`）；MCP `mwf_recall` 对 30 秒内完全相同的请求（含文件指纹校验）复用结果。SessionStart/UserPromptSubmit 的 `hooks.json` timeout 由 15 秒降为 5 秒，runner 截止由 14.5 秒降为 4.5 秒（0.3.0 的临时上调撤销；数值为暂定，真机验证推迟到 1.0）；runner 按事件取截止时间（`--stop` 事件保持 14.5 秒，见 `codex/timeouts.ts`）。hook 路径的项目锁总等待上限为 2 秒（`withLockDeadline`），锁被占用时 fail-open 输出“未恢复记忆”提示，而不是被 4.5 秒 SIGKILL。新增 `scripts/measure-hook.ts` 用于测量冷启动 hook 延迟。

## 0.3.1

### 文档

- readme 更新：去掉“尚未发布”字样；新增 npm 安装与使用（`npm install -g @zht7063/mwf`、`npx @zht7063/mwf`）。代码与 0.3.0 相同。

## 0.3.0

### 破坏性变更

- 移除 0.1 支持：删除 `lifecycle/migrate.ts`；0.1 项目返回 `UNSUPPORTED_LEGACY_INSTALL` 且不写文件，`migrate --from 0.1` 仅给出该错误。受管白名单不再包含 `.pi/*` 与 `.agents/skills/*`。
- receipt 升至 v3：status/doctor 仅在内存中升级 v2；`--apply` 操作先原子写入 v3 再做其他变更。v2 receipt 仍拥有 0.1 资源时一律返回 `LEGACY_RESOURCE_PENDING` 且不改动，需先用 0.2.x detach。
- **不可降级**：写成 v3 后 0.2.x 无法读取；回到 0.2.x 前须先用 0.3.0 detach，见 [UNINSTALL](packaging/UNINSTALL.md#no-downgrade-after-receipt-v3)。
- 删除转发桩 `src/storage.ts`、`setup.ts`、`pi-adapter.ts`、`protocol.ts`、`integrations/shared/identity.ts`；包入口仍为 `src/core.ts`。

### 重构

- 分层为 contracts → storage → retrieval/context → core → integrations → lifecycle → cli/mcp；`HarnessAdapter` 契约（`contracts/harness.ts`）与 `integrations/registry.ts` 统一适配器访问；封闭受管白名单 `contracts/managed-surface.ts`，仅 storage 校验写入。见 [架构](docs/architecture.md)。
- 发行产物：`zht7063-mwf-0.3.0.tgz`、`mwf-codex-0.3.0.zip`、`SHA256SUMS`、`RELEASE-STATUS.json`；产物名由 package.json 版本派生。

### 发布标准变更

- **发布判定标准已变更**为 [linux-cli-harness/1](docs/release-criteria.md)：移除真实环境验收要求（44 项证据、两个真实宿主、桌面、macOS、性能报告）；Linux 命令行中 Codex CLI 与 Pi harness 对同一 commit 全部通过即可发布。`pack:release` 依据 `releases/evidence/*.json` 计算 `publishable`，证据缺失或任一失败即为 `false`。
- 未验证项：Codex 桌面 GUI、macOS、性能报告、真实（计费）模型宿主。本版本不声称已完全验证。

### 修复

- Codex hook 截止时间由 5 秒上调为 15 秒（`packaging/codex/hooks/hooks.json`），runner 由 4.7 秒上调为 14.5 秒。原因：慢主机（rain，2 核）上 js-tiktoken o200k_base 初始化约 2.8 秒，hook 实测 3.9–5.1 秒，超过旧截止，记忆未注入。每条消息都会触发 UserPromptSubmit，因此在慢机器上每条消息最多可能等待约 15 秒；快机器不受影响。 14.5 秒约为实测最慢值的 3 倍，不是已证明的上界；后续将懒加载/缓存 tokenizer 并下调截止（[#30](https://github.com/zht7063/memory-with-files/issues/30)）。

- doctor 在启用 Pi 且 `.pi/mcp.json` 存在冲突的 `mcpServers.mwf` 时报告 `OWNERSHIP_CONFLICT`（`ok: false`）（issue #20）；status 不报告此项。

相关 PR：[#17](https://github.com/zht7063/memory-with-files/pull/17)、[#21](https://github.com/zht7063/memory-with-files/pull/21), [#22](https://github.com/zht7063/memory-with-files/pull/22), [#23](https://github.com/zht7063/memory-with-files/pull/23), [#24](https://github.com/zht7063/memory-with-files/pull/24), [#25](https://github.com/zht7063/memory-with-files/pull/25), [#26](https://github.com/zht7063/memory-with-files/pull/26), [#27](https://github.com/zht7063/memory-with-files/pull/27), [#28](https://github.com/zht7063/memory-with-files/pull/28)。

发布资格以 `RELEASE-STATUS.json` 计算结果为准（见 [发布判定标准](docs/release-criteria.md)）；桌面、macOS、性能与真实宿主仍未验证。

## 0.2.0 — 未发布

- 初始化与宿主启用分离；普通操作不写规则文件。
- API 2、receipt 2、scoped handoff 1；保留 Markdown/schema 1、事务、journal、恢复和幂等。
- 持久 session/task 交接、revision/hash 冲突保护、中文检索、状态/路径资格过滤。
- 离线 o200k_base、摘要/正文分离、双预算、版本 cursor、epoch 预算预留。
- attach/rebind、分客户端 detach、所有权冲突保留、保守旧版迁移。
- Pi 原生包扩展、Codex 包内 runtime/hooks、单源发行包与校验和。
- Node 下限 22.19.0，项目许可证 MIT。

发布仍受完整 44 项验收、双宿主 GUI/工作流和性能报告约束；本条不表示已经满足发布资格。

## 0.1.0 — 迁入基线

固定上游源码与 25 项历史测试，见 docs/validation/baseline-import.md。
