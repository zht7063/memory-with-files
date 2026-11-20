# 0019 `.mwf/` 进 git；项目根定位

- 状态：已接受（2026-11-20）

## 决定

- `mwf init` 默认让 `.mwf/` 进 git，团队共享记忆；`mwf init --local` 时把 `.mwf/` 写进 `.gitignore`。
- 无论哪种模式，`.mwf/.lock` 等机器本地文件都不进 git。
- `init` 必须在 git 仓库根目录执行。
- 其他命令从当前目录向上查找 `.mwf/` 来确定项目。
