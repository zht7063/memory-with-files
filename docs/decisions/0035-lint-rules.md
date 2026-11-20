# 0035 lint 规则与级别

- 状态：已接受（2026-11-20）

## 决定

| 级别 | 规则 |
| --- | --- |
| error | frontmatter 不合法（缺字段、type 不在枚举内、summary 超长等） |
| error | slug 与文件名不一致 / slug 字符非法 |
| error | 存量页面中检测到 secret（复用 [0025](0025-secret-scanning.md) 的规则） |
| warning | 悬空链接（指向不存在的页面） |
| warning | 孤立页（没有任何入链） |
| warning | `active` 的 `task` 页 30 天未更新 |
| warning | `index.md` 与页面不一致 |
| warning | `possible_duplicate`：两页 BM25 相似度过高（[0040](0040-llm-wiki-workflow.md) 补充） |

有 error 时 `mwf lint` 退出 1；只有 warning 时退出 0。
