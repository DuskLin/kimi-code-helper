import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KimiSessionMetrics } from '../src/main/services/kimi-session-metrics'

const usage = (output = 20) => ({
  type: 'usage.record',
  usageScope: 'turn',
  usage: { inputOther: 10, output, inputCacheRead: 80, inputCacheCreation: 10 }
})
const step = {
  type: 'context.append_loop_event',
  time: 1000,
  event: { type: 'step.end', usage: { output: 20 }, llmStreamDurationMs: 500 }
}
test('准确分会话，包含子代理，step.end 不重复累计，追加读取不重复计数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'navo-session-metrics-'))
  try {
    const main = join(root, 'workspace', 'session_a', 'agents', 'main'),
      sub = join(root, 'workspace', 'session_a', 'agents', 'agent-1'),
      other = join(root, 'workspace', 'session_b', 'agents', 'main')
    for (const path of [main, sub, other]) await mkdir(path, { recursive: true })
    await writeFile(
      join(main, 'wire.jsonl'),
      [usage(), step, { type: 'turn.prompt', input: 'PRIVATE_CONTENT' }]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n'
    )
    await writeFile(join(sub, 'wire.jsonl'), JSON.stringify(usage(30)) + '\n')
    await writeFile(join(other, 'wire.jsonl'), JSON.stringify(usage(1000)) + '\n')
    const reader = new KimiSessionMetrics(root)
    const first = await reader.snapshot()
    assert.equal(first.session_a.totalTokens, 250)
    assert.equal(first.session_a.tokensPerSecond, 40)
    assert.equal(first.session_a.cacheHitRate, 0.8)
    assert.equal(first.session_a.agents, 2)
    assert.equal(first.session_b.totalTokens, 1100)
    assert.deepEqual(await reader.snapshot(), first)
    assert.ok(!JSON.stringify(first).includes('PRIVATE_CONTENT'))
    await appendFile(join(main, 'wire.jsonl'), JSON.stringify(usage()))
    assert.equal((await reader.snapshot()).session_a.totalTokens, null)
    await appendFile(join(main, 'wire.jsonl'), '\n')
    assert.equal((await reader.snapshot()).session_a.totalTokens, 370)
    await writeFile(join(main, 'wire.jsonl'), JSON.stringify(usage()) + '\n')
    const reset = await reader.snapshot()
    assert.equal(reset.session_a.totalTokens, 250)
    assert.equal(reset.session_a.tokensPerSecond, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
