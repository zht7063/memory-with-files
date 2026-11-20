# 0022 用 dist 发布

- 状态：已接受（2026-11-20）；落实 [0004](0004-distribution.md)

## 决定

用 `dist`（原 cargo-dist）生成：

- GitHub Actions 交叉编译 release 工作流（平台见 [0012](0012-toolchain-platforms.md)）
- GitHub Release 附件
- Homebrew tap 中的 formula

## 需要仓库所有者做的事

- 创建 tap 仓库（如 `<owner>/homebrew-tap`），并为 release 工作流配置写入该仓库的 token。
