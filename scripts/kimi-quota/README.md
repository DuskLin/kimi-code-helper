# Kimi Code 顶部额度条（实验版）

已在 macOS 的 Kimi Code 1.0.1 实机验证。仅展示 Navo 账号池已启用的账号：Kimi / Go 额度、DeepSeek 余额。根据顶部实际空白区显示 1～3 张卡片，更多账号可通过横向滚动、触控板或左右按钮查看；点击卡片查看重置时间。不会将展示账号认定为桌面登录账号或当前会话实际调度账号。

首选入口：Navo → 设置 → Kimi Code Desktop。

- **顶部账号额度**：开启时注入，关闭时移除自己的脚本入口，已打开页面在下一次同步后隐藏。
- **重新注入**：手动恢复 Desktop 更新后被覆盖的补丁。
- **更新后自动恢复注入**：默认关闭。开启后，在 Navo 运行期间每 30 秒检测；连续两次检测到资源稳定且布局特征兼容后自动恢复。不强制重启 Desktop，按 `⌘R` 或重新打开窗口加载补丁。若仍显示旧版，可用 `⌘⇧R` 强制刷新。
- 结构不兼容、权限不足或更新尚未完成时停止写入，并显示状态。

安装：`node scripts/kimi-quota/patch.mjs install`，然后在 Kimi Code 按 `⌘R`。

卸载：`node scripts/kimi-quota/patch.mjs uninstall`，然后在 Kimi Code 按 `⌘R`。

命令行入口需要 Node 22.18+。与设置页共用同一补丁管理器。

需要运行包含此改动的 Navo。Navo 每 5 秒将白名单展示字段写入应用资源，页面同源读取；无额外监听端口，不导出 API Key、网关密钥、请求内容。额度查询仍使用 Navo 既有刷新逻辑。同步停止超过 20 秒、额度超过 2 分钟或已到重置时间时显示等待更新，停用账号在下一次同步时自动移除。

原始 HTML 及版本信息保存在 `~/Library/Application Support/Navo/kimi-desktop-backups/<入口摘要>/`。初版实验备份保留在 `kimi-quota-experiment-backup/`。卸载只删除当前入口中自己的精确脚本标记，保留新版入口和其他修改。脚本 URL 带内容版本标识，避免旧资源缓存。补丁修改签名覆盖的资源，但不重新签名；此版使用固定应用路径，只对检测到 `.chat-header` / `.ch-spacer` 的布局尝试注入。特征检查不等于对未来版本的完整兼容保证。

验证：`node scripts/kimi-quota/verify.mjs`（隔离页面模拟数据，不修改真实额度）。
