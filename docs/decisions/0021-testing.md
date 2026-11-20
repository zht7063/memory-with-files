# 0021 测试策略

- 状态：已接受（2026-11-20）

## 决定

- **单元测试**：每个 crate 内部；`mwf-domain`、`mwf-search` 是纯计算，覆盖最密。
- **端到端测试**：`mwf` bin crate 用 `assert_cmd` 在临时目录里运行真实二进制。
- **快照测试**：CLI 输出与 hook 输出（JSON）用 `insta`。
- **基准测试**：5000 页的 BM25 检索基准，守住 [0011](0011-search-in-memory-bigram.md) 的性能假设（约 100 ms）。
