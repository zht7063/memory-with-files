# 数据初始化资源

状态：目录骨架；尚无功能实现。

从基线迁移 schema 1 数据目录模板和简短 protocol 说明。

## 实现约束

- 模板只描述数据格式及用法，不包含写入业务项目 AGENTS/CLAUDE 的激活规则。
- 保留既有 Markdown、frontmatter、ID、inbox 和 legacy handoff 语义。
- 本目录是发布资源，不是项目的实际 .mwf 数据；不存放本机 receipt 或会话状态。

## 实施与验收

- 阶段：M1 随初始化实现迁移；M3 验证旧资源清理。
- 依据：构建规范 §4、§13；L03–L04、G02–G04。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
