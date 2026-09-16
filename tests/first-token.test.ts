import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { FirstTokenObserver } from '../src/main/services/first-token'

async function observe(parts: Buffer[]) {
  let calls = 0
  const bytes: Buffer[] = []
  const observer = new FirstTokenObserver(() => calls++)
  observer.on('data', (chunk) => bytes.push(chunk))
  const end = once(observer, 'end')
  for (const part of parts) observer.write(part)
  observer.end()
  await end
  assert.deepEqual(Buffer.concat(bytes), Buffer.concat(parts))
  return calls
}

test('首 token 识别三个协议的文本、思考和工具调用，跨分块与 UTF-8 原样透传', async () => {
  for (const payload of [
    { choices: [{ delta: { content: '你好' } }] },
    { choices: [{ delta: { reasoning_content: '思考' } }] },
    { choices: [{ delta: { tool_calls: [{ function: { name: 'search' } }] } }] },
    { type: 'response.output_text.delta', delta: '你好' },
    { type: 'response.reasoning_text.delta', delta: '思考' },
    { type: 'response.function_call_arguments.delta', delta: '{}' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } }
  ]) {
    const data = Buffer.from(
      `: heartbeat\r\n\r\ndata: ${JSON.stringify(payload)}\r\n\r\ndata: [DONE]\n\n`
    )
    assert.equal(await observe(Array.from(data, (byte) => Buffer.from([byte]))), 1)
  }
})

test('心跳、初始化、usage、错误、空输出和不完整事件不记录首 token', async () => {
  const payloads = [
    { type: 'response.created' },
    { type: 'response.in_progress' },
    { type: 'response.output_item.added', item: { type: 'message', content: [] } },
    { type: 'message_start', message: { content: [] } },
    { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    { choices: [{ delta: { role: 'assistant', content: '' } }] },
    { choices: [], usage: { total_tokens: 12 } },
    { type: 'response.failed', error: { message: 'error' } },
    { type: 'ping' }
  ]
  const data =
    ': heartbeat\n\n' +
    payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('') +
    'data: [DONE]\n\ndata: {"type":"response.output_text.delta","delta":"unfinished"}'
  assert.equal(await observe([Buffer.from(data)]), 0)
})

test('支持 event 字段、多行 data，仅计时一次；超大事件停止观察但继续透传', async () => {
  const event = 'event: response.output_text.delta\ndata: {\ndata: "delta":"hello"}\n\n'
  assert.equal(await observe([Buffer.from(event + event)]), 1)
  assert.equal(
    await observe([
      Buffer.from('data: ' + 'x'.repeat(1024 * 1024 + 1)),
      Buffer.from('\n\n' + event)
    ]),
    0
  )
})
