# 0055 新增宿主 pi 与 Antigravity

- 状态：已接受（2026-11-24）；取代 [0020](0020-hosts.md) 中的“Pi 延后”；细化 [0024](0024-bypass-guard.md)、[0031](0031-install-scope.md)、[0051](0051-hook-apis-and-session-state.md)、[0052](0052-install-and-uninstall.md)
- 实现：两个宿主各分两步落地，先 Antigravity，后 pi（hooks、lifecycle 与 pi 的扩展资产）。在它们合并之前，不要从 `v2` 发布正式版：本文档与 skill 的命令速查已经列出两个新宿主。
- 修订（2026-11-24，Antigravity 实现）：补充 Stop 在模型出错与用户中断时的实测结果、没有可用 `cwd` 时不退回进程目录、pre-tool 在参数错误时也放行，以及 lifecycle 输出中插件文件的形式。
- 修订（2026-11-24，pi 实现）：补充 pi 的 Stop 在中断与出错时的实测结果、`session_compact` 的实测、prompt id 的前缀，以及 lifecycle 输出中扩展文件的形式。

## 背景

2.0.0 只支持 Claude Code 与 Codex。现在要支持：

- **pi**：earendil-works/pi（原 badlogic/pi-mono），文档在 pi.dev/docs。
- **Antigravity**：Google 的 Antigravity，命令行是 `agy`，文档在 antigravity.google/docs。它的 App、IDE 与 CLI 共用 `~/.gemini/config/`。

两者的 hook 模型都与 Claude 不同，而且文档与实际行为有出入。因此下面的事实是在真实的 `agy` 1.5.16 与 pi 1.6.0 上实测得到的（2026-11-24）。实测用本地 mock 代替模型：agy 设 `modelProvider: gemini`，并把 `GOOGLE_GEMINI_BASE_URL` 指向 Gemini API mock；pi 在 `models.json` 里配置一个 OpenAI chat-completions mock。mock 按脚本返回文本或工具调用，并记录每次请求，所以能看到 hook 注入的内容是否真的进入了下一次模型请求。hook 的 stdin 全部记录。场景包括 headless `-p`、stream-json 多 prompt，以及 tmux 中的交互模式。

## 已查证的宿主事实

### Antigravity（agy 1.5.16）

- **hooks 位置**：全局 `~/.gemini/config/hooks.json`，插件 `~/.gemini/config/plugins/<名>/hooks.json`（另有 `plugin.json`），工作区 `.agents/hooks.json`。插件目录放好后自动启用，不需要信任；`agy plugin list` 能列出，`agy plugin validate` 能通过。交互模式只对工作区目录弹信任提示，不针对 hook。**没有**重定位 `~/.gemini` 的环境变量（antigravity-cli issue #155）。
- **形状**：`{"<组名>": {"SessionStart": [h], "PreInvocation": [h], "Stop": [h], "PreToolUse": [{"matcher": "<正则>", "hooks": [h]}]}}`，`h = {"type":"command","command":…,"timeout":秒}`（默认 30）。hook 进程的工作目录是 hooks.json 所在目录（插件根目录）。
- **输入**（camelCase）：`conversationId`、`cwd`（启动 agy 的目录；文档未列出）、`workspacePaths`、`hookEventName`、`lastUserInput`、`modelName`、`transcriptPath`、`artifactDirectoryPath`。PreInvocation 另有 `invocationNum`、`initialNumSteps`；Stop 另有 `executionNum`、`terminationReason`、`fullyIdle`、`continuationActive`、`error`；PreToolUse 另有 `toolCall: {name, args, id}`。
- **SessionStart**：每个对话一次，在第一条 prompt 到达时触发。交互模式里 `/clear` 产生新的 `conversationId`，并再次触发 SessionStart。CLI 没有压缩事件。
- **没有 UserPromptSubmit**。PreInvocation 在每次模型调用前都触发；`invocationNum` 在每条用户 prompt 开始时归 0。
- **注入**：SessionStart 与 PreInvocation 输出 `{"injectSteps":[{"systemMessage":{"systemMessage":…}}]}`，内容以 system message 进入对话，之后每次模型请求都还在，所以注入会累积。
- **Stop**：`{"decision":"continue","reason":…}` 把 `reason` 作为 system message 注入并继续；最多继续 10 次。`continuationActive` 始终为 false，不可用。`executionNum` 每继续一次加 1，每条新 prompt 归 0。
  - 模型出错（mock 返回 HTTP 400）时 Stop **照样触发**，`terminationReason` 为 `ERROR`，`error` 是错误信息；此时回答 `continue` 会**重新进入循环**，即重试失败的 turn。正常结束时 `terminationReason` 为 `NO_TOOL_CALL`，`error` 为空串。
  - 用户在交互模式按 Esc 中断时（“Interrupted”）**不触发 Stop**，等待 30 s 也没有。
- **工具**：实际提供给模型的是 `read_file`、`write_file`（`Path`、`Content`）、`edit_file`（`Path`、`Target`、`Replacement`）和 `run_command`（`CommandLine`，**没有** `Cwd`）。文档列出的 `write_to_file` / `replace_file_content` / `TargetFile` 在 CLI 中不存在。`write_file` 只接受绝对路径（相对路径由 agy 自己拒绝：`must be an absolute path`）；守卫仍按 `cwd` 解析相对路径，以防将来放开。
- **PreToolUse 失败时拦截（fail closed）**，与文档说的“忽略”相反。退出码非 0、输出不是 JSON、超时、命令不存在（127）都会拦下工具调用，**输出 `{}` 也算拒绝**；只有空 stdout 或 `{"decision":"allow"}` 才放行。`{"decision":"deny","reason":R}` 让工具结果变成 `tool call denied by pre-tool hook: R`。SessionStart、PreInvocation、Stop 失败时放行。
- **skills**：读 `~/.gemini/config/skills/`，也读 `~/.agents/skills/`。同名时只出现一次，`~/.gemini/config/skills/` 优先。

### pi（1.6.0）

- **没有命令 hook**，只有进程内的 TypeScript 扩展。全局扩展 `$PI_CODING_AGENT_DIR/extensions/<名>/index.ts`（默认 `~/.pi/agent`）自动加载，不需要信任；只有项目内的 `.pi/extensions` 需要信任。
- **事件**：
  - `session_start`：`reason` 为 `startup` / `reload` / `new` / `resume` / `fork`，`/new` 时换新的 session id。
  - `session_compact`：`/compact` 压缩完成后触发（pi 实现时实测；`-p` 模式把 `/compact` 当普通 prompt）。
  - `before_agent_start`：有 `prompt` 与 `messageType`；返回的 `message` 作为 user 角色消息进入对话，并持续保留。
  - `tool_call`：返回 `{block: true, reason}` 时，工具结果就是 `reason`。
  - `agent_before_settle`：返回 `{entries: [{type: "custom_message", customType, content, display}], continue: true}` 让模型多跑一轮。**pi 自己不防循环**。事件带 `outcome`：`completed`、`aborted`（Esc）或 `error`（模型出错且 pi 的自动重试用完）。
- **上下文**：`ctx.cwd`、`ctx.sessionManager.getSessionId()`。`pi.exec` 不能传 stdin，要用 `node:child_process`。
- **工具**：`write` 与 `edit` 的路径在 `input.path`（可以是相对路径），`bash` 的命令在 `input.command`。
- **`tool_call` 处理函数抛异常会拦下工具**（fail closed）；其他事件抛异常只记一行错误。
- **skills**：读 `~/.pi/agent/skills/`、`~/.agents/skills/` 与项目内的位置；同名时 agent 目录优先。

## 决定

### 宿主名与命令

- 新的 `--host` 取值：`pi`、`antigravity`；`agy` 是 `antigravity` 的别名，`mwf hook` 与 `install` / `uninstall` 都接受。`install` 写入的命令一律用 `--host antigravity`。认出 mwf 条目时，两种写法都算 Antigravity（0052）。
- 事件名不变：`mwf hook session-start|prompt|stop|pre-tool --host <宿主>`，仍然恒退出 0。
- 最低版本：agy 1.5.16、pi 1.6.0（实测版本）。只写进文档，运行时不检查。

### Antigravity：安装

- 安装形式是 **mwf 独占的插件目录** `~/.gemini/config/plugins/mwf/`，含两个文件：
  - `plugin.json`：`{"name": "mwf", "displayName": "mwf", "version": "<mwf 版本>", "description": …}`。
  - `hooks.json`：一个组 `"mwf"`，四个事件。SessionStart、PreInvocation、Stop 用扁平数组；PreToolUse 的 matcher 为 `write_file|edit_file|run_command`。handler 为 `{"type":"command","command":"<mwf> hook <event> --host antigravity","timeout":10}`。
- 不改用户的 `~/.gemini/config/hooks.json`：agy 的 `/hooks` 会改写它，而插件目录只归 mwf，`uninstall` 不必合并、拆分用户的 JSON。
- 两个文件按 0052 对 skill 文件的规则管理：内容与本二进制要写的不同就先备份再改写；内容相同为 `unchanged`；`uninstall` 删除两个文件（与本版本不同的先备份），再删除变空的 `mwf/`。上一级的 `plugins/` 不删。
- 基准目录是 `HOME`；`.gemini/config/plugins/mwf/` 等缺少的目录逐级创建（与 `.codex/` 相同）。符号链接、身份核对、原子写与备份同 0052。
- 用户在 agy 中禁用了插件时，`install` 不会重新启用它（启用状态不在插件目录中）。
- `hooks.json` 整个由 mwf 写出：内容与本二进制要写的字节相同为 `unchanged`，否则（含不是 JSON 的文件）先备份再改写。`uninstall` 时，文件恰好是某次 install 写出的样子（四个事件、任意 mwf 程序路径）就不备份，否则先备份。
- **输出**（0052 的形状加一个键）：`hooks` 指插件的 `hooks.json`，`events` 的键是 `SessionStart`、`PreInvocation`、`Stop`、`PreToolUse`，状态比较新旧文件中该事件的内容（旧文件不是 JSON 时各事件为 `updated` / `removed`）；`plugin` 为 `{"path","status","backup"}`，在 `hooks` 与 `skill` 之间，只在 `antigravity` 时出现；文本输出相应多一行 `plugin: <路径>: <状态>`。`install` 的 notes 总是提醒先 `uninstall` 再删除或移动 mwf。由 `crates/mwf/tests/snapshots/lifecycle_antigravity.snap` 固定。

### Antigravity：hook 输入与输出

| mwf 事件 | agy 事件 | 规则 | 有内容时的输出 |
| --- | --- | --- | --- |
| session-start | SessionStart | 会话 = `conversationId`；不 reset（`/clear` 已是新会话，也没有压缩事件） | `{"injectSteps":[{"systemMessage":{"systemMessage":<fence 文本>}}]}` |
| prompt | PreInvocation | 只在 `invocationNum == 0` 时 recall（每条用户 prompt 一次），否则 `{}`；prompt = `lastUserInput` | 同上 |
| stop | Stop | 只在 `executionNum == 0`、`error` 为空且 `terminationReason` 为 `NO_TOOL_CALL`（或文档写的 `model_stop`，不分大小写）时调用 `stop_reminder`；其他情况（续出的轮次、出错、`max_steps_exceeded` 等）输出 `{}`，不让已失败或被截断的 turn 继续。turn 缺失（0051：返回 true） | `{"decision":"continue","reason":<提醒>}` |
| pre-tool | PreToolUse | `write_file` / `edit_file` 读 `toolCall.args.Path`；`run_command` 把 `toolCall.args.CommandLine` 交给 shell 检测（含 0053 的 `-c` 解包） | `{"decision":"deny","reason":…}` |

- **项目根**：`cwd`；缺失或不是绝对路径时用 `workspacePaths[0]`（同样须是绝对路径）。**两者都不可用时什么都不做**：输出“空”，stderr 一行。不退回进程目录：hook 进程的工作目录是插件目录，不是项目。相对的 `Path` 以同一个基准解析。
- **pre-tool 永不输出 `{}`**：放行、没有 `.mwf/`、坏输入、超过截止时间、任何错误（含 panic 被捕获），都输出 `{"decision":"allow"}`。参数本身有错（未知选项、`--host` 重复等）时，只要参数中有 `pre-tool` 与 `--host antigravity|agy`，也输出 allow：这一判断直接扫描原始参数，不依赖完整的参数解析。其他三个事件的“空”仍是 `{}`。
- **app 错误**（SessionStart / prompt）：agy 没有只给用户看的 `systemMessage` 顶层字段；`injectSteps` 的 `errorMessage` 会在 `-p` 模式下让整轮以非 0 退出。所以把 0051 的提示文本 ``mwf: <event> hook skipped (<CODE>); run `mwf lint` `` 作为一条 system message 注入，由 agent 转告用户。
- 预算同 0051（内部截止 3 s、stdin 1 MiB、每次注入最多 9800 字符），宿主超时写 10 s。

### Antigravity：fail closed 的风险（接受）

agy 在 PreToolUse 出错时拦截。mwf 二进制被删除或改名、`PATH` 变化、进程被杀或超时，都会让 agy 中匹配到的写文件与 shell 调用全部失败。接受这个风险，缓解措施如下：

- matcher 只覆盖 `write_file|edit_file|run_command`，不用 `*`；`read_file` 等不受影响。
- `install --host antigravity` 的 notes 说明：删除或移动 mwf 之前先运行 `mwf uninstall --host antigravity`，否则 agy 会拦下文件编辑与 shell 命令。
- 内部截止 3 s 远小于 10 s 的宿主超时。

### pi：TypeScript 桥接扩展

- `install --host pi` 写入 `$PI_CODING_AGENT_DIR/extensions/mwf/index.ts`（未设置时为 `~/.pi/agent/extensions/mwf/index.ts`）。`extensions/mwf/` 归 mwf，文件按 0052 对 skill 文件的规则管理。基准目录是 `PI_CODING_AGENT_DIR` 或 `HOME`，规则同 `CODEX_HOME`（为空视同未设置，不是绝对路径或不是目录为 `INVALID_ENV`）。
- **输出**（0052 的形状，不加键）：`hooks` 指扩展文件 `extensions/mwf/index.ts`，`status` 是这个文件的状态；`events` 的键是扩展处理的 pi 事件 `session_start`、`before_agent_start`、`agent_before_settle`、`tool_call`，状态都跟随文件（`created` 记为 `added`，其余同名）。`install` 有改动时 notes 提醒已打开的 pi 会话运行 `/reload`。`uninstall` 删掉空的 `extensions/mwf/`。由 `crates/mwf/tests/snapshots/lifecycle_pi.snap` 固定。
- 扩展的文本是 `mwf-assets` 的模板 `PI_EXTENSION_TS`。install 把 mwf 程序的路径以 JSON 字符串字面量填入：选 `mwf` 还是当前二进制的路径，按 0037 / 0052 的规则；这里是 argv[0]，不是 shell 命令，所以不加 shell 引号。
- 扩展只做翻译，不含业务逻辑：用 `child_process.execFile(<mwf>, ["hook", <event>, "--host", "pi"])` 把一个 JSON 写进 stdin，超时 10 s，读回一行 JSON。**每个处理函数都包在 try/catch 中**：spawn 失败、非 0 退出、超时、坏 JSON 都当作 `{}`，即放行、不注入。所以与 agy 不同，pi 在 mwf 缺失时放行。
- **传给 mwf 的输入与 mwf 的输出都沿用 Claude 的 JSON 形状**，`mwf-hooks` 中 pi 的分支几乎复用 Claude 的：

| mwf 事件 | pi 事件 | 输入 | 扩展如何使用输出 |
| --- | --- | --- | --- |
| session-start | `session_start` 与 `session_compact` 之后的第一次 `before_agent_start` | `{session_id, cwd, source}`，`source` 为 `session_start` 的 `reason`（`reload` 记作 `startup`），`session_compact` 之后为 `compact`（mwf 先 reset，0051） | `hookSpecificOutput.additionalContext` 与 recall 合成一条 `message`（`customType: "mwf"`，`display: false`） |
| prompt | `before_agent_start`，只在 `messageType == "user"` 时 | `{session_id, cwd, prompt}` | 同上 |
| stop | `agent_before_settle`，只在 `outcome == "completed"` 时 | `{session_id, cwd, prompt_id, stop_hook_active: false}`；`prompt_id` 是本次加载的前缀（进程号、加载时间、随机串）加用户 prompt 的计数，`/reload` 后计数重来也不会撞上已提醒过的 turn；刚由提醒续出的那一轮不调用 mwf | `hookSpecificOutput.additionalContext` → `{entries: [{type: "custom_message", customType: "mwf", content, display: false}], continue: true}` |
| pre-tool | `tool_call`，只在 `toolName` 为 `write` / `edit` / `bash` 时 | `{session_id, cwd, tool_name, tool_input}` | `permissionDecision: "deny"` → `{block: true, reason}` |

- `systemMessage`（app 错误）由扩展在有 UI 时用 `ctx.ui.notify` 显示，否则忽略。
- 守卫：`write` / `edit` 读 `tool_input.path`（相对路径以 `cwd` 为基准），`bash` 读 `tool_input.command`。用户自己用 `!` 运行的命令（`user_bash`）不拦。第三方扩展注册的写工具不覆盖。
- Stop 不让被中断或出错的 turn 继续：`outcome` 不是 `completed` 时扩展直接返回。
- pi 实现时在真实的 pi 1.6.0 上用构建出的 `mwf` 实测（mock 模型，`-p` 与 tmux 中的交互模式）：
  - session-start 的上下文与 recall 合成一条消息进入第一次模型请求。
  - `write` 与 `bash` 写 `.mwf/` 被拦下，工具结果是拒绝理由。
  - 一个 turn 只提醒一次，只多跑一轮。
  - mwf 不在 PATH 上时，工具照常运行，也没有提醒。
  - Esc 中断后没有提醒请求，下一条 prompt 照常提醒。
  - 模型一直返回 HTTP 500 时，pi 重试 3 次后以出错结束，没有提醒；HTTP 400 被 pi 自动重试成功时，turn 正常完成，照常提醒一次。
  - `/compact` 之后的第一条 prompt 重新带上 session-start 的上下文，第二条不带；`/reload` 之后同样重新带上，turn 也照常提醒。

### 共享的 skill

- Codex、pi、Antigravity 共用 **`~/.agents/skills/mwf/`**：三者都读这个目录（Codex 见 0052，另两者为实测）。Claude 仍用自己的 `skills/mwf/`。
- `install --host codex|pi|antigravity` 写入 skill 的规则不变（0052）。
- `uninstall --host X`（X 为三者之一）在**另一个共享宿主仍安装着**时保留 skill，并在 notes 中说明由哪个宿主保留。“仍安装着”的判定：
  - Codex：`$CODEX_HOME/hooks.json` 中有 `--host codex` 的 mwf 条目。
  - pi：`extensions/mwf/index.ts` 存在。
  - Antigravity：`~/.gemini/config/plugins/mwf/` 中有 `plugin.json` 或 `hooks.json`。
- 判定时读不了（环境变量不合法、文件不是 JSON、类型不对等）就当作仍安装着、保留 skill，并在 notes 中说明。宁可留下 skill，也不误删另一个宿主正在用的。
- 保留时 skill 的状态为 `unchanged`，notes 说明由哪个宿主保留（或无法判断）。

### 守卫覆盖（0024 的补充）

| 宿主 | 编辑类 | shell |
| --- | --- | --- |
| `antigravity` | `write_file`、`edit_file`：`args.Path` | `run_command`：`args.CommandLine` |
| `pi` | `write`、`edit`：`path` | `bash`：`command` |

仍然只是护栏：MCP 工具、子代理与第三方扩展的工具不在覆盖范围内，由 `mwf lint` 兜底。

## 后果

- `mwf-hooks` 增加 `Host::Antigravity`（输入归一化、四种输出、pre-tool 永不输出 `{}`）与 `Host::Pi`（复用 Claude 的形状，工具名不同）。`mwf-lifecycle` 增加插件目录、扩展文件，以及共享 skill 的保留规则。`mwf-assets` 增加 `PI_EXTENSION_TS`。app 及以下不变（0020 的预期成立）。
- `uninstall --host codex` 的行为变化：pi 或 Antigravity 仍安装着时，不再删除 `~/.agents/skills/mwf/`。
- 环境变量增加 `PI_CODING_AGENT_DIR`；`INVALID_ENV` 的范围随之扩大。
- [cli.md](../cli.md)、[crates/adapters.md](../crates/adapters.md) 与 skill 的命令速查列出新宿主。README 在实现 PR 中更新：它描述的是已发布的版本。
