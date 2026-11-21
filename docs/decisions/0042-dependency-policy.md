# 0042 第三方依赖策略

- 状态：已接受（2026-11-20）
- 注：`mwf-store` 的白名单已由 [0046](0046-pre-p0-doc-fixes.md) 增加 `serde_json`；`cargo-deny` 的许可证白名单见 0046。

## 决定

- 每个 crate 允许使用的第三方库写在 [crates/](../crates/) 对应文档的"依赖"一节；新增依赖必须先改文档。
- CI 运行 `cargo-deny`：许可证白名单、禁止重复主版本、安全公告。
- 初始白名单：

| crate | 依赖 |
| --- | --- |
| mwf-domain | `regex`、`sha2`、`thiserror` |
| mwf-search | `unicode-segmentation` |
| mwf-store | `toml`、`serde`、`thiserror` |
| mwf-app | `serde`、`serde_json`、`thiserror` |
| mwf-cli | `clap`（derive）、`serde_json` |
| mwf-hooks | `serde`、`serde_json`、`rand` |
| mwf-lifecycle | `serde_json`、`thiserror` |
| mwf-assets | 无 |
| 开发依赖 | `assert_cmd`、`insta`、`tempfile`、`divan` |
