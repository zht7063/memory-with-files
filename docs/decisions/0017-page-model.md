# 0017 页面模型与目录布局

- 状态：已接受（2026-11-20）
- 注：文中 `[[slug]]` 链接语法已被 [0038](0038-markdown-links.md) 取代，改为 `[文字](slug.md)`。

## 决定

### 一种概念：页面

记忆只有"页面"一种概念。1.x 的 handoff、inbox、propose 全部取消：

- 会话交接写成 `type: task` 的页面，结构（当前进度、下一步、阻塞点）由 skill 约定。
- 没有待审收件箱；人通过 git diff 审查改动。

### frontmatter

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 页面标题 |
| `summary` | 是 | 一句话摘要（[0027](0027-summary-and-index-md.md) 补充） |
| `type` | 是 | `preference` / `decision` / `incident` / `knowledge` / `task` 之一 |
| `tags` | 否 | 字符串列表 |
| `status` | 是 | `active` / `archived`（默认 `active`） |
| `created` / `updated` | 是 | 由 mwf 维护，agent 不写 |

1.x 的 `paths` 作用域取消，关联关系用 `[[链接]]` 与 `tags` 表达。

### 布局

```
.mwf/
  pages/<slug>.md   所有页面平铺
  index.md          目录（mwf 生成）
  log.md            写操作日志（mwf 追加）
  config.toml
  .lock             写锁（不进 git）
```

- slug = 文件名 = `[[slug]]` 链接目标，全局唯一，字符集 `[a-z0-9-]`。
- 不按类型分子目录：改类型不移动文件，链接不带路径。
