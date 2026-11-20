# 0027 `summary` 字段与 `index.md` 格式

- 状态：已接受（2026-11-20）；补充 [0017](0017-page-model.md)
- 注：文中 `[[slug]]` 链接语法已被 [0038](0038-markdown-links.md) 取代，改为 `[文字](slug.md)`。

## 决定

### summary

frontmatter 增加必填字段 `summary`：一句话，最多 120 个字符，不含换行。用于 `index.md`、搜索结果与 hook 注入，让 agent 不读正文也知道页面讲什么。

### index.md

```markdown
<!-- 由 mwf 生成，勿手改 -->
# 目录

## preference
- [[slug]] 标题 — summary

## decision
…
```

- 分组顺序：preference → decision → knowledge → incident → task；组内按 slug 排序（输出确定）。
- `archived` 页面不列出。
- 每次写入后在同一把锁内重建。
