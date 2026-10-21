# 检索

状态：已实现（T01 从 Core 拆出到本目录）。依赖 `storage/` 与 `contracts/`。

## 文件与导出

- `index.ts`：`normalize`（NFKC + 小写）、`tokens`（汉字 bigram + 英文词）、`globMatch`（path 约束）、`recallRecords`（状态资格过滤、tool/component 等结构化匹配、可解释排序）、`eligible`（默认／review／history 资格，get 同样受约束）。
- `src/core/index.ts` 转导出 `recallRecords`、`eligible`。

## 约束

- 状态过滤不能被高分绕过；不引入向量检索、模型调用或 Adapter 私有排序。
- 分层：contracts → storage → **retrieval** → core。

## 依据

- 构建规范 §7.1–7.3；R03–R09。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
