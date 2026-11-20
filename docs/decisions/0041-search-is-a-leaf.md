# 0041 `mwf-search` 不依赖 `mwf-domain`

- 状态：已接受（2026-11-20）；修改 [0015](0015-crate-topology.md) 中 `search → domain` 一条边

## 决定

`mwf-search` 只接受自己定义的 `Doc { id, title, summary, tags, body }`，不依赖任何 workspace crate。页面转成 `Doc` 的工作在 `mwf-app` 中完成。

## 理由

search 只需要几个字符串；去掉这条边后 search 成为零依赖叶子 crate，跨层依赖再少一条，也可独立测试与基准。
