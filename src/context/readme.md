# 上下文计量与渲染

状态：目录骨架；尚无功能实现。

离线参考 tokenizer、统一模型可见输出、预算裁剪和正文分页。

## 实现约束

- 锁定 o200k_base 实现及词表；计量名称为 reference_tokens，不冒充真实模型计费 token。
- 按最终序列化文本同时检查 token 和 UTF-8 bytes；协议、元数据、错误／partial 提示均计入。
- 正文按 Unicode code point 分页，cursor 固定内容 hash；交接另固定 scope/revision。
- 不能重复输出 context_text 和相同正文 JSON；事故条件不足时不单独留下修复建议。
- 本目录不判断宿主是否接收；epoch 去重及原子额度预留由 integrations/shared 管理。

## 实施与验收

- 阶段：M2。
- 依据：构建规范 §6.3、§7.4–7.5、§8.1；R01–R02、R09–R11、S07。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
