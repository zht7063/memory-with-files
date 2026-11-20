# 0038 链接用标准 Markdown 语法 + 相对路径

- 状态：已接受（2026-11-20）；取代 [0008](0008-llm-wiki-division.md)、[0017](0017-page-model.md) 中关于 `[[链接]]` 的部分

## 决定

- 页面之间：`[文字](slug.md)`，可带锚点 `slug.md#小节`；`./slug.md` 与 `slug.md` 等价。
- `index.md`（位于 `.mwf/`）：`[标题](pages/slug.md)`。
- **内部链接**需同时满足：无 scheme；锚点前的路径以 `.md` 结尾；按相对路径解析后落在 `.mwf/pages/` 内。其余一律为外部链接（http、指向代码的 `../../src/db.rs` 等），不计入反向链接、不做 lint。
- `rename <old> <new>` 改写所有内部链接中的 `old.md` 目标，保留文字与锚点。
- 链接到不存在的页面允许写入，命令输出警告；lint 记 warning（GitHub 上点开是 404，可接受）。
- 解析器位于 `mwf-domain`，需正确跳过代码块与行内代码中的 `[..](..)`。

## 理由

GitHub、VS Code 等可直接点击；agent 最熟悉这种格式；页面平铺，相对路径就是 `slug.md`，不啰嗦。
