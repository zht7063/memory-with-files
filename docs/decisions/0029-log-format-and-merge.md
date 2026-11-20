# 0029 `log.md` 格式与 git 合并

- 状态：已接受（2026-11-20）；细化 [0018](0018-log-md.md)

## 决定

- 每行：`<RFC3339 UTC 时间> <op> <slug> "<title>"`，例如 `2026-11-20T10:00:00Z new use-bm25 "Use BM25 for search"`。`rename` 记作 `rename <old>-><new>`。
- `mwf init`（git 模式）写入 `.gitattributes`：`.mwf/log.md merge=union`，并发追加在合并时保留两边的行。
- `index.md` 合并冲突不需特殊处理：下一次写入或 `mwf index --rebuild` 会重新生成。
