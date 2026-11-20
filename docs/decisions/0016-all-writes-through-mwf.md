# 0016 `.mwf/` 的所有写入都经过 mwf

- 状态：已接受（2026-11-20）；补充 [0008](0008-llm-wiki-division.md)

## 背景

两种选择：agent 用自己的编辑工具直接改 `.mwf/` 下的文件、mwf 事后 lint；或所有写入都走 mwf CLI，由 Rust 核心在写入时把关。

## 决定

`.mwf/` 下的一切写入都由 mwf 的 Rust 核心完成。页面**内容**仍由 agent 撰写（0008 不变），但持久化必须通过 `mwf` 命令。

## 后果

- 校验（frontmatter、slug、链接）、secret 扫描都在**写入前**执行，不合格的写入被拒绝，什么都不落盘。
- 每次写入后，mwf 在同一把锁内重建 `index.md` 并追加 `log.md`，目录永远与页面一致。
- 需要设计一组适合 agent 的写命令（新建、整页替换、局部修改、归档、改名……），见 open-questions。
- 需要考虑如何防止 agent 绕过 mwf 直接编辑 `.mwf/`（宿主 hook 拦截 / skill 约束），见 open-questions。
