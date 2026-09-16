import { Transform, type TransformCallback } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0
function output(value: unknown): boolean {
  const item = record(value)
  if (
    ['text', 'thinking', 'reasoning', 'transcript', 'arguments', 'partial_json'].some((key) =>
      text(item[key])
    )
  )
    return true
  if (
    ['function_call', 'custom_tool_call', 'tool_use'].includes(String(item.type)) &&
    text(item.name)
  )
    return true
  return Array.isArray(item.content) && item.content.some(output)
}

function startsOutput(data: string, event: string): boolean {
  let payload: Record<string, unknown>
  try {
    payload = record(JSON.parse(data))
  } catch {
    return false
  }
  const type = typeof payload.type === 'string' ? payload.type : event
  if (payload.error || type === 'error' || type === 'response.failed') return false
  // Chat Completions：role-only、usage-only 和结束帧不算首 token。
  if (Array.isArray(payload.choices))
    return payload.choices.some((choice) => {
      const delta = record(record(choice).delta)
      return (
        ['content', 'reasoning_content', 'reasoning'].some((key) => text(delta[key])) ||
        text(record(delta.function_call).name) ||
        text(record(delta.function_call).arguments) ||
        (Array.isArray(delta.tool_calls) &&
          delta.tool_calls.some((call) => {
            const fn = record(record(call).function)
            return text(fn.name) || text(fn.arguments)
          }))
      )
    })
  // Anthropic Messages。
  if (type === 'content_block_delta') return output(payload.delta)
  if (type === 'content_block_start') return output(payload.content_block)
  // Responses：忽略 created/in_progress 等初始化帧。
  if (type.startsWith('response.') && type.endsWith('.delta')) return text(payload.delta)
  if (type === 'response.output_item.added' || type === 'response.output_item.done')
    return output(payload.item)
  if (type === 'response.content_part.added' || type === 'response.content_part.done')
    return output(payload.part)
  if (type === 'response.completed' || type === 'response.done') {
    const items = record(payload.response).output
    return Array.isArray(items) && items.some(output)
  }
  return type.startsWith('response.') && type.endsWith('.done') && output(payload)
}

/** 仅旁路观察 SSE；转发原始字节，保留背压，不收集完整响应。 */
export class FirstTokenObserver extends Transform {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private data: string[] = []
  private event = ''
  private size = 0
  private done = false
  constructor(private readonly onToken: () => void) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.done) {
      this.pending += this.decoder.write(chunk)
      let newline: number
      while (!this.done && (newline = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, newline).replace(/\r$/, '')
        this.pending = this.pending.slice(newline + 1)
        this.size += line.length
        if (this.size > 1024 * 1024) {
          this.finish()
          break
        }
        if (!line) {
          if (startsOutput(this.data.join('\n'), this.event)) {
            this.onToken()
            this.finish()
          }
          this.data = []
          this.event = ''
          this.size = 0
        } else if (line.startsWith('data:')) {
          this.data.push(line.slice(5).replace(/^ /, ''))
        } else if (line.startsWith('event:')) this.event = line.slice(6).trim()
      }
      // 超大或不规范事件仅停止计时，不能中断上游透传。
      if (this.pending.length + this.size > 1024 * 1024) this.finish()
    }
    callback(null, chunk)
  }
  private finish(): void {
    this.done = true
    this.pending = ''
    this.data = []
    this.event = ''
  }
}
