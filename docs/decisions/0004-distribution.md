# 0004 分发：GitHub Releases + Homebrew tap，放弃 npm

- 状态：已接受（2026-11-20）

## 决定

- 各平台预编译二进制发布到 GitHub Releases。
- 维护一个 Homebrew tap（`brew install <owner>/tap/mwf`）。
- 不再发布 npm 包。

## 后果

- 需要一条 release CI（交叉编译矩阵 + 自动更新 tap formula）。目标平台见 open-questions。
- lifecycle 写入宿主配置的命令应引用安装后的 `mwf` 绝对路径或 PATH 上的 `mwf`，不再依赖 Node 入口。
