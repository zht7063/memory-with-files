# Changelog

## 0.2.0 — 未发布

- 初始化与宿主启用分离；普通操作不写规则文件。
- API 2、receipt 2、scoped handoff 1；保留 Markdown/schema 1、事务、journal、恢复和幂等。
- 持久 session/task 交接、revision/hash 冲突保护、中文检索、状态/路径资格过滤。
- 离线 o200k_base、摘要/正文分离、双预算、版本 cursor、epoch 预算预留。
- attach/rebind、分客户端 detach、所有权冲突保留、保守旧版迁移。
- Pi 原生包扩展、Codex 包内 runtime/hooks、单源发行包与校验和。
- Node 下限 22.19.0，项目许可证 MIT。

发布仍受完整 44 项验收、双宿主 GUI/工作流和性能报告约束；本条不表示已经满足发布资格。

## 0.1.0 — 迁入基线

固定上游源码与 25 项历史测试，见 docs/validation/baseline-import.md。
