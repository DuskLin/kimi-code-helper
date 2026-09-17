# Harness 客户端识别

核对日期：2026-09-17。实时调用页支持 Zcode、Kimi Code、Claude Code、Codex、Qoder、WorkBuddy、Pi、DeepSeek Harness、Cline，保留 Key、OpenCode 和 Cursor。

UA 是客户端自行声明的归属，不是认证信息。识别不读取提示词、不依赖 model 名称、不保存原始 UA，也不改变上游 UA、账号池或密钥校验。

## 自动识别与来源

| 客户端           | 匹配的产品标识举例                                                                                                       | 核对依据及限制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zcode            | `ZCode/…`、`zcode`                                                                                                       | 保留既有兼容规则；[官网](https://zcode.z.ai)未提供稳定的模型请求 UA 契约，不能声称所有版本均已实测。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Kimi Code        | `kimi-code-cli/…`（含 `(web)` 后缀）、`kimi-code-desktop/…`、`kimi-code-vscode/…`、`KimiCLI/…`、`kimi-code`、`Kimi Code` | [官方 UA 生成代码](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/constant.py)，Python 版产品 token 为 `KimiCLI`；本机 TypeScript 版 `kimi-code/apps/kimi-code/src/constant/app.ts` 的 `CLI_USER_AGENT_PRODUCT` 为 `kimi-code-cli`，上述客户端均支持。另核对本机 Kimi Code.app 的 `DESKTOP_PRODUCT_NAME=kimi-code-desktop`、`DESKTOP_MSH_PLATFORM=kimi_code_desktop`，以及 SDK `packages/oauth/src/identity.ts`；支持 `X-Msh-Platform` 的 `kimi_code_cli`、`kimi_code_desktop`、`kimi_code_vscode` 精确匹配兜底。 |
| Claude Code      | `claude-cli/…`、`claude-code`、`Claude`                                                                                  | [官方仓库的实际请求记录](https://github.com/anthropics/claude-code/issues/39013)包含 `claude-cli/版本 (external, cli)`；裸 `Anthropic/JS` 不可归类为 Claude Code。                                                                                                                                                                                                                                                                                                                                                                                                   |
| Codex            | `codex_cli_rs/…`、`codex-tui`、`codex_vscode`、`codex`                                                                   | [官方 HTTP 客户端](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/default_client.rs)由 originator 生成 UA；补上此前漏掉的下划线形式，也读取明确的官方 `originator` 值。                                                                                                                                                                                                                                                                                                                                                                           |
| Qoder            | `qoder/…`、`qodercli/…`、`Qoder-Cli`                                                                                     | 查阅 [官方 npm 发布包 1.1.54](https://registry.npmjs.org/@qoder-ai/qodercli/1.1.54)，bundle 中存在 `qoder/版本` 的 HTTP 请求标识；这不证明所有模型通道均使用同一 UA。[官方自定义模型文档](https://docs.qoder.com/zh/qoder/custom-models)支持自定义 Base URL。                                                                                                                                                                                                                                                                                                        |
| WorkBuddy        | `WorkBuddy/…`，可出现在 `CLI/…` 等其他产品 token 后面                                                                    | [腾讯官方 Harness 发布包](https://registry.npmjs.org/@tencent-ai/agent-harness/0.1.6)的 `docs/product.md` 说明 IDE identity 组成 `WorkBuddy/<desktop-version>`。缺少 productName 的请求不会自动标作 WorkBuddy，因此单独 `CLI` 或 `CodeBuddy` 不归类为 WorkBuddy。                                                                                                                                                                                                                                                                                                    |
| Pi               | `pi (平台信息)`、`pi (browser)`、`pi-coding-agent`；兼容 `pi.dev`                                                        | [官方 UA 生成代码](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/ai/src/utils/pi-user-agent.ts)；[归属头实现](https://github.com/earendil-works/pi/blob/e4c75a73222ae2c72abb5f5314fa35ee8effc508/packages/coding-agent/src/core/provider-attribution.ts)还会在相关通道发送 `x-opencode-client: pi`。                                                                                                                                                                                                                   |
| DeepSeek Harness | `deepseek-harness/版本 (+项目地址)`                                                                                      | [官方 attribution 实现](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/llm/llm/src/attribution.ts)规定产品 token；裸 `DeepSeek` 或模型 ID 不算 Harness 标识。                                                                                                                                                                                                                                                                                                                                                |
| Cline            | `Cline/…`、`cline-sdk` 等                                                                                                | [官方请求头实现](https://github.com/cline/cline/blob/48285afa652e97a548a3ab3a6c41376ccc152fbb/sdk/packages/llms/src/providers/request-headers.ts)对 Cline、OpenAI Codex 和 OpenCode Go 等通道发送 Cline UA，部分其他通道只使用已配置 headers。另识别明确的 `x-client-type: cline-*` 与 `originator: cline`。不能把通用或压缩后的 JS SDK UA 全当作 Cline。                                                                                                                                                                                                            |

匹配不区分大小写，跳过括号注释及版本，仅匹配完整产品 token。例如 `SDK/1 (+https://pi.dev)`、`raspberry-pi/1`、`deepseek-v4` 都不会冒充客户端。

## 确保客户端归属的接入方式

默认 Base URL 仍为 `http://127.0.0.1:17300/v1`。若客户端只发送通用 UA、移除了标识，或者通过其他代理改写 UA，可在模型设置中改用以下专属 Base URL；实际端口以网关设置为准，专属地址见下表（调度页已按界面精简要求移除接入地址入口）。

| 客户端           | Base URL                                             |
| ---------------- | ---------------------------------------------------- |
| Zcode            | `http://127.0.0.1:17300/harness/zcode/v1`            |
| Kimi Code        | `http://127.0.0.1:17300/harness/kimi-code/v1`        |
| Claude Code      | `http://127.0.0.1:17300/harness/claude-code/v1`      |
| Codex            | `http://127.0.0.1:17300/harness/codex/v1`            |
| Qoder            | `http://127.0.0.1:17300/harness/qoder/v1`            |
| WorkBuddy        | `http://127.0.0.1:17300/harness/workbuddy/v1`        |
| Pi               | `http://127.0.0.1:17300/harness/pi/v1`               |
| DeepSeek Harness | `http://127.0.0.1:17300/harness/deepseek-harness/v1` |
| Cline            | `http://127.0.0.1:17300/harness/cline/v1`            |

地址支持 `/v1/models`、Chat Completions、Responses、Messages 和 count_tokens；也支持 `/harness/<id>/api.json`，目录中的 API 地址会保留该客户端前缀。若客户端（例如 Anthropic SDK）自行补 `/v1/messages`，配置 Base URL 时去掉末尾 `/v1`。仍需按原规则配置 API Key，专属路径不会绕过局域网鉴权。

支持自定义请求头的客户端也可配置 `X-Kimi-Helper-Harness: cline` 等目录中的小写 ID。优先级为：专属路径 → 明确配置的请求头 → 已核对的原生归属头 → UA。无可靠标识则显示“未知客户端”。这些额外归属头不向上游转发。

调度器仍使用原粘性会话保持账号亲和。展示层按 Harness + 粘性会话汇总：同一个会话的主 Agent、子 Agent、并发请求都归入一个“调用”节点，即使带独立 Agent ID 也不拆开。节点显示实时并发数，并按实际模型分支累计当前视图的 Token 与传输量。没有会话标识的请求保持独立，避免误合并无关客户端。

## 验证边界

测试覆盖产品 UA、通用 SDK 与模型名误判、显式归属优先级、所有专属地址的真实 HTTP 转发、三种模型协议、鉴权与跨域拒绝，以及 Electron 中页面切换与调用图的展示。没有实际安装并逐个发起九种客户端的完整端到端调用；未知 UA 版本可以使用专属地址确定归属。

会话节点在最后一个请求结束后按调度页顶栏滑块选择保留 5、10、15、30 或 60 分钟（默认 5 分钟，松开滑块后自动保存并生效），等待期间显示用户提供的 `bot-off.svg`；有新请求时恢复 `bot.svg`。请求仍在进行时不开始空闲过期计时。详细请求记录保留数量有上限，但每个等待节点至少保留一条记录直至其空闲过期。
