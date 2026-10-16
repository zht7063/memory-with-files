# 从 0.1.0 迁移

先备份项目（含 `.mwf/local/` 和隐藏配置），停止旧进程、旧 adapter 和旧自动入口。新数据格式兼容 schema 1，不等于旧接入/API 1 兼容。普通 init 不接管旧自动入口。

```sh
node /absolute/new-runtime/dist/cli.js migrate --root /absolute/project --from 0.1
node /absolute/new-runtime/dist/cli.js migrate --root /absolute/project --from 0.1 --legacy-stopped --apply
node /absolute/new-runtime/dist/cli.js doctor --root /absolute/project
```

`--legacy-stopped` 是操作者确认，不自动结束旧进程。先看预检结果再应用。只有可证明归属的旧规则块和配置资源会删除；修改块、重复 marker、未知配置语法或所有权不明时拒绝，原文不变。旧 receipt 的整文件 hash 已变化时保守拒绝，不据此覆盖用户配置。

迁移复用事务/journal 并保留备份，长期 Markdown、ID、frontmatter、正文、inbox、旧 handoff 原文保留；退役字段移除，生成 disabled 新状态。随后从安装包显式 attach 指定客户端并重载，不能依赖旧 setup 激活规则文件。`setup` 只是已弃用兼容入口。

失败后保留现场并运行 doctor；不要手工覆盖 journal 或清空 local。进程中断后的下一次受锁操作会恢复事务；外部修改造成冲突时停止并人工合并。恢复备份前停用所有新旧入口，使用完整备份恢复对应数据与配置。数据遗忘和接入卸载是不同操作。
