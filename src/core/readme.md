# Core 用例

状态：目录骨架；尚无功能实现。

记录、交接、bootstrap/recall/get 和维护操作的确定性实现。

## 实现约束

- 从固定 0.1.0 基线迁移；不重写已验证的存储保证。
- 使用 contracts、storage、retrieval 和 context；不导入宿主 SDK、不读取宿主配置、不调用模型或网络。
- 自动读取不生成正式记忆；所有交接写入复用事务，revision 比较和写入在同一锁内。
- status/doctor 的数据健康与宿主接入健康分离；disabled 不代表数据损坏。

## 实施与验收

- 阶段：M1 核心解耦；M2 记忆行为。
- 依据：构建规范 §4、§6–8、§14；G01–G02、S01–S05、S10–S11。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
