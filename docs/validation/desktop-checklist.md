# 0.2.0 桌面人工验收

状态：**not_run，阻塞发布**。当前自动化工具不能操作 Codex 桌面 GUI；以下操作须由具有该能力的操作者执行，不能以本轮 CLI/app-server 结果代替。不要在真实工作项目做破坏性故障实验。

## 准备与证据

1. 保存 `releases/SHA256SUMS`、Node 绝对路径/版本、操作系统/架构、Pi 版本、Codex 桌面构建号、日期和测试人。
2. 建立两个包含中文和空格的临时项目 A/B、一个未启用子项目；保留 A 可用。使用正式 zip/tarball，经正常入口安装，不手工 import 扩展。
3. 记录每一步操作、截图或宿主日志、实际请求观测、工具输出及文件前后 hash。只保存合成数据，删除凭据和私人内容。每项标记 pass/fail/not_run，关联 L/S/R/G 编号和产物 hash。

## Codex 桌面完整流程

1. L02/L05/G08：正常安装插件，未启用项目发任务，不创建 `.mwf`，不自动加载记忆。记录安装入口及插件版本。
2. L03/L04：包内 setup 初始化 A（明确 Git mode），预览/应用 attach。已有 AGENTS/CLAUDE hash 不变；无规则文件项目不新增规则文件。
3. G06：不信任/禁用 hooks，记录不注入的真实请求；按 GUI 正常流程信任并重载，禁止用 CLI bypass flag 当证据。
4. G05/G09：提交唯一合成记忆版本 V1，新会话/真实任务看到 V1。人为延迟 MCP 10 秒、启动失败时分别观察 hook、本地读取、工具降级和模型请求时序。证明“直接读取不等待 MCP”，不得推导“整个宿主调用不等待”。
5. S01/S02/S11：并行两会话分别保存交接；用同 task revision 冲突写；退出 hook 后由永久 MCP 使用显式 session_ref 读写。随机/跨 root 引用失败。
6. S06/S07：更新 V2，compact/resume/clear 后下次必要请求包含 V2；摘要已经注入仍可 get 正文。会话结束本身不写正式记忆。
7. L06/L07/L11：从子目录启动；未启用子项目阻断父项目。复制 A→B（A 保持 enabled），让 B 的 MCP 先于 hook 启动，确认不能访问 A。再移动 A/删除旧插件目录，确认 stale 状态，不静默改配置。
8. L08–L12/S09/G10：双客户端启用；分别 detach 不影响另一个；无关 TOML 注释保留；修改 MWF 自有块后 detach 先 disabled 并报告 cleanup pending。重接后旧 MCP 仍被拒绝。卸载并重载无自动注入；重新安装/rebind 后原记忆与交接仍可读。
9. GUI Node：从桌面启动而非继承开发 shell，记录 hook 实际 Node 路径；PATH 缺 Node、旧 runtime、超时均短提示且任务可继续。同会话同类错误不重复（磁盘损坏/只读不能持久去重时另记）。

## Pi 补充流程

除已有真实脚本外，验证 compact、session_tree、session replacement、热 reload、项目切换。检查用户/项目同名 MCP 和旧 adapter 冲突；注销旧注册，不能留下旧 root 闭包。卸包、重载、重装后再次观察真实请求和工具列表。

## 完成与关闭

将脱敏记录放在 `docs/validation/`，更新 acceptance-0.2.0.json 的单项证据。Linux/最低 Node 适用组合另测，不能由 macOS 推导。全部 44 项及完整三路性能报告通过后才重新评估发布资格。此清单不授权自动 npm publish。
