# 0032 frontmatter 语法：手写的 YAML 子集

- 状态：已接受（2026-11-20）

## 决定

- 页面以 YAML `---` 块开头（GitHub 等会渲染成表格）。
- 只支持本项目用到的子集：标量字符串（必要时加双引号）与行内列表 `[a, b]`。不支持多行字符串、嵌套映射、锚点等。
- 解析与渲染在 `mwf-domain` 中手写，不引入 YAML 库。mwf 输出的 frontmatter 字段顺序固定：`title`、`type`、`summary`、`tags`、`status`、`created`、`updated`。

## 理由

所有写入都经过 mwf（[0016](0016-all-writes-through-mwf.md)），格式完全由我们控制；Rust YAML 库生态不稳定（serde_yaml 已停止维护）。
