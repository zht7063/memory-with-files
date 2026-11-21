# 0046 开工前的文档补正

- 状态：已接受（2026-11-21）；补充 [0042](0042-dependency-policy.md)、[0043](0043-errors-and-clock.md)，对齐 [0039](0039-bm25-scoring-and-relevance.md) 与 [cli.md](../cli.md)

## 背景

P0 开工前复查文档，发现几处已接受的决定彼此不一致或缺少细节。

## 决定

### `mwf-store` 增加 `serde_json`

[0034](0034-session-state.md) 规定会话状态存为 `.mwf/.state/<session_id>.json`，由 `mwf-store` 读写，但 0042 的白名单里 store 没有 `serde_json`。store 的白名单改为 `toml`、`serde`、`serde_json`、`thiserror`。

### `mwf search` 增加 `--status`

0039 规定 `archived` 页默认不参与检索、`--status all` 时参与，但 cli.md 的 `search` 没有这个参数。`search` 增加 `[--status active|archived|all]`，默认 `active`，与 `list` 一致。

### `cargo-deny` 在 P0 引入

0042 要求 CI 运行 `cargo-deny`，P0 的 CI 一并加入，仓库根目录放 `deny.toml`：

- 许可证白名单：`MIT`、`Apache-2.0`、`Apache-2.0 WITH LLVM-exception`、`BSD-2-Clause`、`BSD-3-Clause`、`ISC`、`Unicode-3.0`、`Zlib`。新增许可证须先改本条。
- 禁止重复主版本（`multiple-versions = "deny"`，确有必要的例外写进 `deny.toml` 并注明原因）。
- 安全公告（`advisories`）检查。

### 时间戳不引入时间库

白名单中没有 `chrono` / `time`，也不新增：

- `mwf-domain` 提供 `Timestamp::from_unix_secs(u64)`，纯计算地把 Unix 秒转成 RFC3339 UTC（`YYYY-MM-DDTHH:MM:SSZ`，秒精度）。
- `mwf-app` 的系统 `Clock` 读 `SystemTime::now()` 后调用它；测试用固定时间的 `Clock`。domain 仍不读时钟（0043）。
