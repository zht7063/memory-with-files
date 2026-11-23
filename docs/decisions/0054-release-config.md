# 0054 dist 的发布配置

- 状态：已接受（2026-11-23）；落实 [0004](0004-distribution.md)、[0012](0012-toolchain-platforms.md)、[0014](0014-name-version.md)、[0022](0022-release-with-dist.md)

## 背景

P4 需要把 0022 的“用 dist 发布”写成具体配置。0004 与 0022 只说了 GitHub Release 与 Homebrew tap，没有说 dist 的其他安装器、哪些 crate 发布、tap 的仓库名与 token，以及 PR 上怎样检查发布配置。

## 决定

### 配置位置与版本

- 配置在仓库根的 `dist-workspace.toml`，固定 `cargo-dist-version = "0.34.0"`；`.github/workflows/release.yml` 由 `dist generate` 生成，**不手改**。改配置或升级 dist 后重新运行 `dist generate` 并提交生成的文件。
- 根 `Cargo.toml` 有 `[profile.dist]`（继承 `release`，`lto = "thin"`），发布包用它构建。

### 发布什么

- 只发布 bin crate `mwf`：workspace 的 `publish = false` 会让 dist 跳过所有 crate，`crates/mwf/Cargo.toml` 用 `[package.metadata.dist] dist = true` 单独打开。其他 crate 不变。
- 目标平台与 0012 一致：`aarch64-apple-darwin`、`x86_64-apple-darwin`、`aarch64-unknown-linux-musl`、`x86_64-unknown-linux-musl`。dist 0.34 为它们分别选用原生 runner（`macos-15`、`macos-15-intel`、`ubuntu-22.04-arm`、`ubuntu-22.04`，Linux 上装 `musl-tools`），产物是静态链接的 `mwf`。
- 每个平台一个 `mwf-<target>.tar.xz`（含 `mwf`、`LICENSE`、`README.md`）及其 `.sha256`，外加 `source.tar.gz`、`sha256.sum`。
- 安装器只有 `homebrew`。**不生成** shell / PowerShell / npm / MSI 安装器，也不启用 updater：0004 只承诺 GitHub Release 与 Homebrew；`curl | sh` 安装器多一条要维护、要审计的安装路径，Linux 用户可用 Linuxbrew 或直接下载 tarball。要加需另立 ADR。

### Homebrew tap

- formula 推送到 `zht7063/homebrew-tap` 的 `Formula/mwf.rb`，用户用 `brew install zht7063/tap/mwf` 安装。formula 覆盖 macOS 与 Linux（Linuxbrew）的两种架构。
- release 工作流的 `publish-homebrew-formula` 作业用仓库 secret **`HOMEBREW_TAP_TOKEN`**（dist 的标准名字）检出并推送 tap 仓库。仓库所有者需要：
  1. 创建公开仓库 `zht7063/homebrew-tap`，带至少一个提交（例如 README），默认分支即推送目标；
  2. 创建一个只对 `zht7063/homebrew-tap` 有 **Contents: Read and write** 权限的 fine-grained personal access token（或带 `repo` 范围的 classic token）；
  3. 在 `zht7063/memory-with-files` 的 Settings → Secrets and variables → Actions 中加入仓库 secret `HOMEBREW_TAP_TOKEN`。
- 预发布版本（版本号带 `-alpha.N` 等后缀）只建 GitHub Release（标为 prerelease），**不更新** tap：dist 默认 `publish-prereleases = false`。这与 implementation-plan 中“`2.0.0-alpha.1` 仅 GitHub Release”一致；`2.0.0` 起才更新 formula。

### 触发与检查

- 推送形如 `v2.0.0` 的 tag 触发发布；tag 的版本必须等于 workspace 的版本（0014），否则 `plan` 作业失败、不发布任何东西。0.x / 1.x 的旧 tag 在 `main` 上，`main` 没有这份工作流，不受影响。
- `pr-run-mode = "plan"`：每个 PR 上 release 工作流只运行 `dist plan`（约一分钟，不构建）。`dist plan` 在 `release.yml` 与配置不一致时失败，所以忘了重新生成会在 PR 上暴露。普通 CI（`ci.yml`）不变。
