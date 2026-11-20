# 0028 读命令、输出格式与退出码

- 状态：已接受（2026-11-20）

## 决定

### 读与其他命令

`show`、`search`、`list`、`lint`、`log`、`index`、`init`、`hook`、`install` / `uninstall`，详见 [cli.md](../cli.md)。

### 输出

- 默认：给 agent 读的简洁纯文本，无颜色、无表格框线。
- `--json`：`{"ok": true, "data": …}` 或 `{"ok": false, "error": {"code": "…", "message": "…"}}`。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 操作失败（被拒绝、冲突、未找到、lint 有 error） |
| 2 | 用法错误（参数不合法） |
