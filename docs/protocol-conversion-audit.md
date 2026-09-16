# 协议转换复核（2026-09-16）

## 结论与来源

当前实现是参考 `sub2api_local` 后编写的 TypeScript 适配层，不是其 Go `apicompat` 包的完整移植。原项目的线上验证不能直接作为本项目实现的验证结论。此前只验证了主要路径，遗漏了协议默认字段、工具历史和流式边界。

本次以本地参考项目的实现与回归用例为依据，先复现失败，再修复。新增 `tests/protocol-audit.test.ts` 的前 10 个用例在修复前全部失败；长命名空间用例另行验证修复前失败；HTTP 集成用例验证过非流式失败时错误地先返回 200。

## 本轮确认的问题（均已修复）

| # | 触发场景 | 原行为与影响 | 修复 |
|---|---|---|---|
| 1 | Responses 带默认 `text.format.type=text`，转 Messages | 合法的纯文本请求被拒绝为 400 | 不把默认文本模式转换成结构化输出要求 |
| 2 | Messages JSON Schema 转 Responses | 缺少格式名称，严格上游可能拒绝 | 补充默认 `name=output` |
| 3 | Responses 工具历史转 Messages，有未回答调用、孤立结果或插入消息 | 缺失配对、结果不在正确位置 | 复用工具历史整理，完整结果紧邻调用，清理未配对历史，不伪造结果 |
| 4 | instructions 与 developer 同时出现，或中途插入 developer | 多个前置 system 或中途 system 导致严格上游拒绝 | 合并前置指令；中途通知保留原位置，以 user 消息传递 |
| 5 | Chat assistant 历史带 `reasoning_content`，转 Responses | 思考上下文被静默丢弃 | 按参考实现将明文 reasoning 放入 assistant 文本，不伪造密文或签名 |
| 6 | Messages 的 `max_tokens` 结束原因之后又到达仅含 usage 的 delta | 截断状态被重置为成功 | 只在新 stop_reason 非空时更新结束原因 |
| 7 | Chat 流先到工具 ID/参数，后到工具名称 | 提前报协议错误，中断合法工具调用 | 延迟声明工具，名称到达后一次性补齐此前参数；仍无名称时明确报错 |
| 8 | 上游尚未返回 usage，但需要发送 Messages `message_start` | 缺少 Messages 线格式必需的 usage 字段 | 为线格式补零值；内部统计仍读取原始上游 usage，不把未知消费计为零 |
| 9 | custom 工具的 JSON 包装缺少字符串 `input` | 静默返回空工具输入 | 明确拒绝无效包装，不执行被清空的工具参数 |
| 10 | Responses JSON 或终止事件内仍为 `in_progress` 等非终态 | 被当成成功完成 | 校验终态，拒绝伪造完成 |
| 11 | namespace + 工具名超过 64 字节 | 上游工具名超限，定义与调用被拒绝 | 使用与参考实现相同的 64 字节截断和 SHA-256 短后缀，往返保持身份 |
| 12 | 非流式转换遇到损坏的上游响应 | 已先发送 HTTP 200，只能断开连接 | 缓冲转换成功后才提交响应；转换失败返回结构化 502 |

上一轮已修复的 Responses → Chat 并行工具调用合并、工具结果排序、工具图片后移、reasoning 回传继续纳入全量回归。

## 对照文件

参考根目录：`/Users/liujialin/project/sub2api_local/backend/internal/`。

- `pkg/apicompat/chatcompletions_responses_bridge.go`：指令位置整理、工具历史、命名空间工具名。
- `pkg/apicompat/responses_to_anthropic_tool_pairing_test.go`：Messages 的调用/结果相邻约束及孤立记录处理。
- `pkg/apicompat/chatcompletions_to_responses.go`：Chat reasoning 的明文回传。
- `pkg/apicompat/chatcompletions_anthropic_bridge.go`：名称延迟到达的工具调用与 Messages 事件。
- `pkg/apicompat/response_format.go`：结构化输出格式形状。
- `pkg/apicompat/streaming_stop_reason_test.go`：截断与终止原因。
- `pkg/apicompat/chatcompletions_responses_stream_lifecycle_test.go`：工具事件生命周期及无效参数。
- `service/openai_gateway_compat_buffered_read_failover_test.go`：缓冲转换失败前不提交成功状态。

## 验证与边界

- 单元与本地 HTTP 集成测试覆盖三种入口和三种原生协议、JSON/SSE、工具多轮回传、图片、缓存用量、错误和取消。
- 同协议请求继续透传，本轮没有把全部原生请求强制经过转换器。
- 没有使用用户真实 API Key 调用付费上游；这些结果不是线上模型全面兼容证明。
- 仍不等同于 sub2api 全部功能：上游托管搜索、动态工具发现、旧版 `functions/function_call`、后台任务、`n>1`，以及跨上游的私有会话/文件引用仍按现有范围明确拒绝。
- `previous_response_id`、`conversation`、`item_reference` 需要上游状态或完整历史，不能凭空恢复；跨协议必须传完整历史。
- 不能跨厂商伪造 reasoning 密文和签名。明确的明文可转换；不透明数据不能保证迁移。
- 已有单事件 1 MB、累计转换内容 16 MB 的限制，以及无终止事件不伪造成功的保护继续保留。

后续新增兼容能力应随同迁入对应的参考回归场景，避免仅根据几个成功请求宣布完整兼容。
