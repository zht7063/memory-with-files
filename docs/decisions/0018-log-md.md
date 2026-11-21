# 0018 `log.md` 写操作日志

- 状态：已接受（2026-11-20）
- 注：下文“待定”一节已由 [0029](0029-log-format-and-merge.md) 解决。

## 决定

mwf 的每一次写操作在 `.mwf/log.md` 末尾追加一行：时间、操作、slug。因为 [0016](0016-all-writes-through-mwf.md) 规定所有写入都经过 mwf，日志是完整的。

## 用途

会话开始时把"最近改动"提供给 agent。

## 待定（已由 [0029](0029-log-format-and-merge.md) 解决）

- 行格式；在团队共享（进 git）时如何避免合并冲突。见 open-questions。
