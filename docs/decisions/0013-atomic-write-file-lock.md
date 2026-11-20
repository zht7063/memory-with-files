# 0013 原子写 + 项目级文件锁，去掉日志与去重

- 状态：已接受（2026-11-20）

## 决定

- mwf 写的每个文件都是"写同目录临时文件 → fsync → rename"。
- mwf 的写操作持有项目级独占锁（std `File::lock`，锁文件 `.mwf/.lock`，进程退出即自动释放）。
- 不再有 1.x 的 intent 日志与崩溃恢复、request_id 去重表、锁心跳与跨主机回收。

## 理由

去掉数据库后，唯一的派生文件 `index.md` 随时可重建；单页写入本身是原子的。崩溃最多留下一个过期目录，下一次写入或 `mwf index` 时重新生成。

## 后果

- 1.x 中约 1500 行（lock / recovery / write / db）没有对应物。
- `File::lock` 需要 Rust ≥ 1.89，与 [0012](0012-toolchain-platforms.md) 的 MSRV 一致。
