# 0037 lifecycle 安全措施与 hook 命令路径

- 状态：已接受（2026-11-20）；细化 [0031](0031-install-scope.md)

## 决定

### 安全

- 修改宿主文件前备份；所有写入原子完成。
- `install` 幂等：重复执行结果不变。
- `uninstall` 只删除命令中带 `mwf hook` 标记的条目及 mwf 安装的 skill，不碰用户自己的配置。
- 支持 `--dry-run`，只打印将要做的改动。
- 拒绝经符号链接写入（目标及其祖先目录）。

### hook 命令里的可执行路径

- 默认写 `mwf`（依赖 PATH）。
- `install` 时检查 PATH 上的 `mwf` 是否就是当前二进制；不是则改写当前二进制的路径并提示。
- 不解析符号链接：Homebrew 的 `/opt/homebrew/bin/mwf` 升级后不变，而 Cellar 中带版本号的真实路径升级后会失效。
