# 生命周期与配置所有权

状态：目录骨架；尚无功能实现。

init、attach、detach、rebind、migrate、兼容 setup 和配置片段所有权。

## 实现约束

- 数据初始化与宿主启用分离；首次 init 显式选择 git-mode，不自动 git add。
- JSON key／TOML 受管条目级所有权；保留无关字段、注释和用户修改，不保存整份共享配置用于回滚。
- detach 先锁内 disabled 再清理；清理冲突保留 receipt，返回 disabled_cleanup_pending。
- root 变化先将所有客户端置 disabled/stale，再仅重绑指定客户端；绑定实际变化才轮换 generation。
- 正常流程不写规则文件；仅 migrate 按旧 hash 或严格历史模板证明归属后删除旧 AGENTS 块。
- attach/rebind 使用已安装的对应插件 runtime；无法定位时失败，不偷偷用全局 CLI 替代。

## 实施与验收

- 阶段：M1 解耦数据 init；M3 完成生命周期和旧入口迁移。
- 依据：构建规范 §9、§12–14；L03–L04、L08–L12、S09、G02–G04、G10。
- 仓库根目录下的 `docs/build-plan-0.2.0.md` 为执行计划，`docs/MWF 0.2.0 构建文档.md` 为目标规范。
