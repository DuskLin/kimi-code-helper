# Kimi Code Helper

基于 Electron、React 和 TypeScript 的 Kimi Code 多账号桌面网关。

## 多账号负载均衡

- **账号**：仅支持 API Key；中国区与国际区；编辑、启停、删除；官方上游地址固定，可用模型、额度与并发上限由上游同步。
- **统一账号池**：无需账号分组，所有账号共同参与调度。已有分组地址与密钥作为兼容入口保留，统一使用同一个账号池。
- **调度**：粘性会话优先；新会话统一按并发与额度均衡评分。先筛选启用状态、模型、认证、冷却、并发和已确认耗尽的额度，再复用可用的会话绑定账号，否则选择得分最高的账号。旧策略自动迁移，旧账号优先级与手动权重不再参与调度。
- **故障切换**：401/403 暂停账号；408/429/5xx、连接失败进入冷却并尝试账号池内的其他账号；429 尊重更长的 `Retry-After`（最多 24 小时）。其他 4xx 原样返回。请求最多尝试配置次数，同一账号不重复尝试。
- **网关**：只监听 `127.0.0.1`，支持 OpenAI Responses、Chat Completions 和 Anthropic Messages，包括 SSE、工具调用、取消和流式背压。已经开始返回响应后不会重试。
- **安全与状态**：系统安全存储加密、原子写入、脱敏 IPC、SQLite 永久保存请求摘要（每页 10 条）、账号并发与成功率统计、启动时自动运行网关。请求记录的延迟列同时显示首字与总耗时，新增思考强度列，记录客户端显式指定的强度；保留真实 requestId，不再显示或采集 traceId。旧记录未设置的字段显示「—」。

首 token 耗时从网关收到请求开始，包含重试等待，到流式响应的首个文本、思考或工具调用输出为止；参考 sub2api 的可见输出计时口径，跳过心跳、初始化、usage-only 和错误事件。非流式或未收到有效输出显示「—」。观察器只解析首个有效事件前的有限数据，原始响应字节仍直接透传；不会保存响应内容。

所有新旧接入地址共享账号并发槽位和粘性会话池；会话标识按模型隔离。会话保持使用 `X-Session-Id` 请求头或 `prompt_cache_key` 字段，账号满载或故障时允许重新分配。

上游地址由区域固定为 `https://api.kimi.com/coding/v1` 或 `https://api.kimi.ai/coding/v1`，界面不可编辑，后台也不会采用提交的自定义地址。填写 API Key 后自动查询 `/models`（支持分页），保存新密钥前也会验证并同步。账号行的同步按钮可以重新获取信息；启动时自动同步未获取过或超过 30 秒的账号信息，未完成首次同步的账号暂不参与调度。

额度和并发统一从 `/usages` 同步，用量请求沿用参考项目的 `User-Agent: KimiCLI/1.6`。并发上限读取 `parallel.limit`（兼容数字和数字字符串），5 小时额度读取相应 `limits[].detail`，7 天额度读取 `usage`，总额度读取 `totalQuota`。账号列表显示剩余额度，编辑窗口展示使用进度和重置时间。用量额度、RPM、TPM、上下文长度不会被当作并发上限；查询失败或未识别到并发值时，使用默认 20 并发并显示「20（默认）」；上游返回有效值（包括 0）时优先采用上游值。旧版未保存额度的缓存会在启动时重新查询。模型和额度只读；账号并发上限支持手动设置 1–1000，手动值优先于上游值，刷新和重启均保留。点击「恢复自动」可重新采用上游值或默认 20。

## 开始使用

1. 启动应用，首屏显示网关控制、成功率，以及已关联账号的 5h / 7D 剩余额度卡片（紧凑显示剩余比例和重置时间，悬停查看额度数值与更新时间），支持单账号刷新，底部状态栏显示网关运行状态与监听地址。点击「账号管理」进入账号池和请求记录；点击「返回概览」回到首屏。
2. 在「账号池」添加两个或更多 Kimi 账号。填写 Kimi Code 控制台生成的 API Key，自动获取上游信息，或点击「获取上游信息」手动刷新。
3. 根据需要修改账号并发上限；新会话自动按并发和剩余额度分配。会话保持时间可在网关设置中修改。
4. 点击「启动网关」，默认端口为 `17300`；端口占用时可停止网关后修改端口。
5. 在账号池点击「地址」「复制密钥」「Kimi 配置」或「Claude 配置」，将客户端指向本地网关。

### Kimi Code CLI

「Kimi 配置」复制的是 TOML 配置示例。合并到 Kimi CLI 的 `~/.kimi/config.toml`，保留原有其他设置；`default_model` 放在文件顶层并设为 `"kimi-helper"`。也可通过 `kimi --model kimi-helper` 选择该模型。

复制的 provider 使用 `type = "kimi"`、网关的 `/v1` 地址与本地密钥，模型使用 `kimi-for-coding`。需要其他模型时修改 `model`，并确认对应账号的上游模型列表包含它。网关不改写模型名。

### Claude Code / 其他 Anthropic 客户端

「Claude 配置」复制网关的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_MODEL`，在启动客户端的终端中执行即可。Anthropic Base URL 不含末尾 `/v1`，SDK 会自行追加 `/v1/messages`。

### 通用 HTTP 接入

接入示例（把密钥替换为应用中复制的**网关密钥**）：

```bash
curl http://127.0.0.1:17300/v1/chat/completions \
  -H 'Authorization: Bearer <网关密钥>' \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: my-session' \
  -d '{"model":"kimi-for-coding","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

支持的端点：`POST /v1/responses`、`POST /v1/chat/completions`、`POST /v1/messages`、`POST /v1/messages/count_tokens`、`GET /v1/models`。旧 `/groups/<分组ID>` 前缀保留兼容，但不再隔离账号池。鉴权接受 `Authorization: Bearer ...` 或 `x-api-key`，分组路径与密钥不匹配时拒绝请求。客户端提供的认证头不会透传，上游请求使用所选账号的凭据。三个生成接口均按原路径转发请求体、查询参数及 JSON/SSE 响应，不进行协议转换。

各接口的最终可用性由上游决定；模型列表透传一个可用账号的结果。请求体上限 8 MB，总超时默认 300 秒，无空闲账号时返回 503。当前不支持 WebSocket、协议转换或跨机器共享网关。

macOS 关闭窗口后网关继续运行，退出应用才停止；其他平台关闭最后一个窗口会退出应用。启用「打开应用时自动启动网关」可在下次启动时恢复监听。统计、会话保持和冷却状态仅保存在内存中，退出后清空；账号、密钥、网关设置和请求摘要持久保存。请求摘要位于用户数据目录的 `gateway.json.requests.sqlite`，不自动清理；页面仅加载 10 条。早于本次更新且已丢失的内存记录无法补回。

## 使用统计

首页统计参考本机 `../cc-switch` 的 UsageHero、UsageTrendChart 与 usage_stats 实现：真实 Tokens 为新增输入、输出、缓存创建和缓存命中之和；命中率为缓存命中 / 全部输入。OpenAI 输入中已包含的缓存会先扣除，Anthropic 分开的输入和缓存分别统计。流式累计用量快照合并覆盖，不重复相加。

首页统一展示当天用量；统计卡片内的刷新按钮默认 5 秒自动刷新，点击按 5 → 15 → 30 → 5 秒循环切换。趋势图支持悬停、方向键查看数值和图例开关，按小时或天聚合。用量摘要随请求永久落盘；已有记录未捕获的用量无法补回。只有上游明确报告 `cost_usd` / `total_cost_usd` 才显示美元费用，不对 Kimi 订阅额度虚构价格；缺失用量或费用显示 N/A。

### 生成速度、中断消耗和热力图

参考 `../kimi-usage-stats` 的时长加权、消耗日历和日期下钻设计。平均生成速度按成功流式请求的输出 token 总数 / 对应上游请求时长总秒数计算（含首字等待，不含先前失败尝试），非流式、旧记录缺少时长或未报告输出的请求不参与平均。按账号 ID 分别汇总当天速度，显示在各自额度卡片内；没有有效样本时显示「—」，不展示迷你柱状图。

网关没有客户端 turnId/轮次中断标记，因此使用“中断请求消耗”口径：由网关的连接、超时和流事件直接记录中断原因，涵盖客户端断开、请求超时、上游传输截断或流内错误、网关退出。缺少正常结束标记的流也会计入；正常 HTTP 错误响应和达到 token 上限的正常终止不误算。每次请求最多计一次，保留中断前已报告的 token 与费用，未报告的用量保持未知。旧记录仅兼容已有 499 标记，无法反推出其他历史中断原因。

每日消耗热力图展示近 112 个本地自然日，周一至周日排列，5 档蓝色表示已报告的 token 总量；有请求但无用量采用斜纹。悬停显示摘要，点击日期显示当天的模型明细。热力图和明细跟随 5/15/30 秒刷新间隔更新。

## 开发

需要 Node.js 22.12 或更高版本，推荐 Node.js 22 LTS。

```bash
npm install
npm run dev
```

窗口右上角可切换浅色／深色模式，重启应用后保留选择。弹窗使用不占内容宽度的悬浮滚动条，滚动时显示，停止后自动淡出，并支持拖拽和键盘滚动。

`npm run dev` 默认启用主进程与预加载脚本监听：修改主进程后等待旧 Electron 完全退出，再启动新进程，避免单实例锁冲突；修改预加载脚本后重新加载界面。首次从旧开发实例升级时，应完整退出旧实例并重新执行此命令；仅刷新界面可能出现 `No handler registered for 'gateway:get'`，因为旧主进程尚未注册新接口。开发重启会中断正在处理的请求，运行网关时可用 `npm start` 启动稳定构建。

## 常用命令

```bash
npm run typecheck    # TypeScript 检查
npm run build        # 编译主进程、预加载脚本和界面
npm start            # 运行已编译的桌面应用
npm test             # 网关测试 + 构建 + 真实 Electron 冒烟测试
npm run test:unit    # 本地模拟上游：调度、转发、流式、存储
npm run test:smoke   # 真实 Electron：界面、加密、持久化与网关
npm run pack         # 生成当前平台的应用目录
npm run dist         # 生成当前平台的安装包
npm run format       # 格式化源代码
npm run format:check # 检查格式
```

桌面冒烟测试需要图形环境和可用的系统安全存储，使用独立临时设置目录与模拟上游，不调用真实 Kimi 服务、不消耗账号额度。截图输出至 `artifacts/`。自动化覆盖不等于真实 Kimi 账号端到端验证；模型可用性需要使用自己的 API Key 验证。

## 目录结构

```text
src/
  main/
    index.ts              # 窗口、生命周期和 IPC 处理
    services/settings.ts       # 主题设置与原子写入
    services/gateway-store.ts  # 账号分组校验、加密配置与串行写入
    services/scheduler.ts      # 并发与额度评分、会话、并发与冷却
    services/kimi-capabilities.ts # 上游模型、额度、并发信息与缓存
    services/gateway.ts        # HTTP 网关、鉴权、故障切换、SSE
  preload/index.ts        # 向界面暴露白名单 API
  shared/contracts.ts    # 跨进程类型与通信通道
  shared/kimi-quota.ts    # 上游额度窗口解析
  renderer/
    index.html
    src/
      App.tsx             # 工作空间和主题切换
      GatewayPanel.tsx    # 网关管理、账号、分组与请求记录
      OverlayScrollArea.tsx # 弹窗悬浮滚动条
      main.tsx            # React 入口和错误边界
      styles.css          # 窗口布局
      theme.css           # 浅色／深色设计变量
scripts/dev.mjs            # 开发监听、串行退出与重启
scripts/smoke.mjs          # 真实 Electron 冒烟验证
tests/gateway.test.ts      # 网关、调度、持久化测试
electron.vite.config.ts    # 开发与构建配置
electron-builder.yml       # 跨平台打包配置
```

主题设置保存在 Electron `app.getPath('userData')` 下的 `settings.json`。macOS 默认位置为 `~/Library/Application Support/Kimi Code Helper/settings.json`。首次启动默认浅色；设置缺失或格式无效时使用默认值。

账号与网关配置位于同目录的 `gateway.json`，使用 Electron `safeStorage` 的系统密钥加密整份配置，再以 `0600` 权限原子写入。Linux 系统密钥环不可用时拒绝保存凭据，不降级到明文存储。加密文件依赖原系统钥匙串，不适合直接复制到另一台机器；无法解密或格式损坏时保留原文件并显示启动错误，不覆盖账号数据。单实例锁防止多个进程同时写入同一份配置。

旧版 OAuth 账号会先将原加密配置备份为同目录的 `gateway.json.oauth-backup`，再转为停用、待填写 API Key 的账号；原名称和分组关联保留。填写 API Key 后可重新启用，不再进行浏览器授权或令牌刷新。

渲染进程启用了沙箱和上下文隔离，并关闭 Node.js 集成。系统操作通过预加载脚本中的受限 API 交给主进程执行，IPC 校验调用来源与输入。

## 打包

构建产物在 `out/`，打包产物在 `dist/`。已配置 macOS（DMG / ZIP）、Windows（NSIS）和 Linux（AppImage）目标。通常在对应系统中生成安装包。macOS 使用本地临时签名（ad hoc），发布签名、公证、应用图标和自动更新尚未配置。

## 设计参考

额度与并发查询参考本机 `../test/server.py` 和 `../test/web/index.html`。网关参考本机 `../sub2api_local` 的 `account_group.go`、`openai_account_scheduler.go` 和 Kimi API Key 凭据设计，将分组、调度、并发和冷却职责分离为桌面本地服务；未引入其服务器端数据库、计费或多租户模块。

协议依据：[Kimi Code 文档](https://www.kimi.com/code/docs/)、[Kimi CLI provider 配置](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers)。

## 并发与额度均衡

新会话（或原绑定账号不可用时）的评分：

`S = 0.5 × (1 - (已占用并发 + 1) / 并发上限) + 0.25 × 5h剩余比例 + 0.25 × 7D剩余比例`

- 各比例在 0–1 范围，选择分数最高的账号。按接入下一请求后的并发计算，预占槽位后才发送请求。同分依次比较占用并发数、上次使用时间、累计请求数。
- **粘性会话优先于评分**：同模型、同会话的绑定账号只要仍可用就继续复用，保留缓存命中优势。满载、额度耗尽、冷却、认证失败等情况下才重新分配。默认保持 300 秒，每次分配续期，设为 0 关闭。
- 网关运行时每 30 秒触发一轮信息同步，不重叠运行。后台刷新不清除冷却、认证失败或会话绑定，手动并发设置不被覆盖。
- 新鲜额度中任一窗口剩余为 0 时暂时跳过。超过 120 秒或越过重置时间的数据视为未知；未知窗口取候选账号已知比例的中位数，全部未知时取 50%，退化为并发均衡。同步失败保留上次真实额度及时间。
- 不保证两个窗口的百分比严格相等：请求成本不同、上游统计延迟、两个窗口余量相反及粘性会话都会影响实际分布。

## License

MIT
