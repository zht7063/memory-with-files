# 0015 crate 拓扑与依赖规则

- 状态：已接受（2026-11-20）；落实 [0005](0005-cargo-workspace-layering.md)

## 决定

采用 [architecture.md](../architecture.md) 中的拓扑：

- `mwf-domain`、`mwf-search`：纯计算，不做 IO；`mwf-search` 独立成 crate，不并入 domain。
- `mwf-store`：全部文件 IO。domain 与 store 不合并。
- `mwf-app`：用例层，定义自己的请求/响应类型（DTO），不把 domain 类型透传给适配器。
- 适配器 `mwf-cli`、`mwf-hooks` 只依赖 `mwf-app`（及纯数据 `mwf-assets`），彼此不依赖。
- `mwf-lifecycle` 只依赖 `mwf-assets`。
- `mwf`（bin）只做分发。

## 后果

- 从适配器的视角，跨层依赖只剩 `app → domain` 一条（用例层编排领域对象所必需）。
