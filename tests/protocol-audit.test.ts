import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  convertRequest,
  type Wire,
  type BridgeContext
} from '../src/main/services/protocol-request'
import { convertResponse } from '../src/main/services/protocol-response'
import type { UsageProtocol } from '../src/shared/usage'

const event = (value: Wire) => `data: ${JSON.stringify(value)}\n\n`
async function translate(
  source: UsageProtocol,
  target: UsageProtocol,
  body: Wire | string,
  outputStream = false,
  context: BridgeContext = { model: 'audit', tools: new Map() }
) {
  const input = typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = async function* () {
    const bytes = Buffer.from(input)
    for (let n = 0; n < bytes.length; n += 11) yield bytes.subarray(n, n + 11)
  }
  const result: Buffer[] = []
  for await (const data of convertResponse(chunks(), {
    source,
    target,
    inputStream: typeof body === 'string',
    outputStream,
    context,
    ok: true
  }))
    result.push(data)
  const text = Buffer.concat(result).toString()
  return outputStream
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map((line) => JSON.parse(line.slice(6)))
    : JSON.parse(text)
}

test('audit: Responses default text format is compatible with Messages', () => {
  const { body } = convertRequest(
    { model: 'minimax-m3', input: 'hello', text: { format: { type: 'text' } } },
    'responses',
    'messages'
  )
  assert.equal(body.output_config, undefined)
  assert.equal(body.messages[0].content[0].text, 'hello')
})

test('audit: Messages json_schema gets the required Responses format name', () => {
  const { body } = convertRequest(
    {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: {} } } }
    },
    'messages',
    'responses'
  )
  assert.equal(body.text.format.name, 'output')
})

test('audit: Anthropic history removes orphan/dangling calls and places paired results first', () => {
  const { body } = convertRequest(
    {
      model: 'minimax-m3',
      input: [
        { role: 'user', content: 'start' },
        { type: 'function_call', name: 'read', call_id: 'call_a', arguments: '{}' },
        { type: 'function_call', name: 'read', call_id: 'call_b', arguments: '{}' },
        { role: 'user', content: 'approval notice' },
        { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
        { type: 'function_call_output', call_id: 'orphan', output: 'ghost' }
      ]
    },
    'responses',
    'messages'
  )
  const assistant = body.messages.findIndex((m: Wire) => m.role === 'assistant')
  assert.deepEqual(
    body.messages[assistant].content.map((p: Wire) => p.id),
    ['call_a']
  )
  assert.equal(body.messages[assistant + 1].content[0].tool_use_id, 'call_a')
  assert.ok(!JSON.stringify(body).includes('ghost'))
  assert.ok(JSON.stringify(body).includes('approval notice'))
})

test('audit: leading instructions merge and mid-conversation developer notices remain at their position', () => {
  const { body } = convertRequest(
    {
      model: 'deepseek-v4.1-flash',
      instructions: 'base',
      input: [
        { role: 'developer', content: 'dev' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'answer' },
        { role: 'developer', content: 'updated notice' }
      ]
    },
    'responses',
    'chat-completions'
  )
  assert.deepEqual(
    body.messages.map((m: Wire) => m.role),
    ['system', 'user', 'assistant', 'user']
  )
  assert.equal(body.messages[0].content, 'base\n\ndev')
  assert.equal(body.messages.at(-1).content, 'updated notice')
})

test('audit: Chat reasoning is retained in Responses history without forged encrypted content', () => {
  const { body } = convertRequest(
    {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'answer', reasoning_content: 'reasoned context' }
      ]
    },
    'chat-completions',
    'responses'
  )
  assert.match(JSON.stringify(body.input), /reasoned context/)
  assert.ok(!JSON.stringify(body.input).includes('encrypted_content'))
})

test('audit: usage-only message_delta does not erase max_tokens stop reason', async () => {
  const input =
    event({ type: 'message_start', message: { id: 'm', model: 'm' } }) +
    event({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 10 }
    }) +
    event({ type: 'message_delta', delta: {}, usage: { output_tokens: 11 } }) +
    event({ type: 'message_stop' })
  const output = await translate('messages', 'responses', input)
  assert.equal(output.status, 'incomplete')
  assert.equal(output.incomplete_details.reason, 'max_output_tokens')
  assert.equal(output.usage.output_tokens, 11)
})

test('audit: streamed tool arguments may precede the name', async () => {
  const input =
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_late', function: { arguments: '{"path":' } }]
          }
        }
      ]
    }) +
    event({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '"a.ts"}' } }] }
        }
      ]
    }) +
    event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
    'data: [DONE]\n\n'
  for (const target of ['responses', 'messages'] as const) {
    const output = await translate('chat-completions', target, input)
    const tool = (output.output ?? output.content)[0]
    assert.equal(tool.name, 'read')
    assert.equal(tool.call_id ?? tool.id, 'call_late')
    assert.deepEqual(tool.input ?? JSON.parse(tool.arguments), { path: 'a.ts' })
  }
})

test('audit: Messages start includes schema-required usage even before upstream usage arrives', async () => {
  const input = event({ choices: [{ delta: { content: 'hi' } }] }) + 'data: [DONE]\n\n'
  const events = await translate('chat-completions', 'messages', input, true)
  assert.equal(events[0].type, 'message_start')
  assert.deepEqual(events[0].message.usage, { input_tokens: 0, output_tokens: 0 })
  assert.equal(events.find((e: Wire) => e.type === 'message_delta').usage.output_tokens, 0)
})

test('audit: malformed custom-tool wrapper must not silently become an empty tool input', async () => {
  const context: BridgeContext = {
    model: 'm',
    tools: new Map([['apply_patch', { name: 'apply_patch', custom: true }]])
  }
  await assert.rejects(
    translate(
      'chat-completions',
      'responses',
      {
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'a', function: { name: 'apply_patch', arguments: '{"wrong":"patch"}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      false,
      context
    ),
    /input/
  )
})

test('audit: nonterminal Responses JSON cannot be reported as a successful completion', async () => {
  await assert.rejects(
    translate('responses', 'chat-completions', { status: 'in_progress', output: [] }),
    /上游/
  )
})

test('audit: long namespace tool names stay within upstream limits and round trip without losing identity', async () => {
  const namespace = 'workspace_connector_' + 'x'.repeat(50)
  const name = 'read_file'
  const { body, context } = convertRequest(
    {
      model: 'deepseek-v4.1-flash',
      tools: [
        {
          type: 'namespace',
          name: namespace,
          tools: [{ type: 'function', name, parameters: { type: 'object' } }]
        }
      ],
      tool_choice: { type: 'function', namespace, name },
      input: [
        { role: 'user', content: 'read' },
        { type: 'function_call', namespace, name, call_id: 'c', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c', output: 'ok' }
      ]
    },
    'responses',
    'chat-completions'
  )
  const upstreamName = body.tools[0].function.name
  assert.match(upstreamName, /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(body.tool_choice.function.name, upstreamName)
  assert.equal(
    body.messages.find((m: Wire) => m.tool_calls).tool_calls[0].function.name,
    upstreamName
  )
  const output = await translate(
    'chat-completions',
    'responses',
    {
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c2', function: { name: upstreamName, arguments: '{}' } }]
          },
          finish_reason: 'tool_calls'
        }
      ]
    },
    false,
    context
  )
  assert.equal(output.output[0].name, name)
  assert.equal(output.output[0].namespace, namespace)
})
