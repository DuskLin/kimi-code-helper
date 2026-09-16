import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import {
  parseUsage,
  heatmapRange,
  heatmapLevel,
  localDayKey,
  type TokenUsage
} from '../src/shared/usage'
import { ResponseIdsObserver } from '../src/main/services/response-ids'
import { RequestHistory } from '../src/main/services/request-history'

test('OpenAI 缓存包含在输入中，Anthropic 独立计数；保留零与未知', () => {
  assert.deepEqual(
    parseUsage(
      {
        response: {
          usage: {
            input_tokens: 1000,
            output_tokens: 100,
            input_tokens_details: { cached_tokens: 800 }
          }
        }
      },
      'responses'
    ),
    { input: 200, output: 100, cacheRead: 800 }
  )
  assert.deepEqual(
    parseUsage(
      {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 800 }
        }
      },
      'chat-completions'
    ),
    { input: 200, output: 100, cacheRead: 800 }
  )
  assert.deepEqual(
    parseUsage(
      {
        message: {
          usage: {
            input_tokens: 200,
            output_tokens: 100,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 50
          }
        }
      },
      'messages'
    ),
    { input: 200, output: 100, cacheRead: 800, cacheWrite: 50 }
  )
  assert.deepEqual(
    parseUsage(
      { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0 } },
      'messages'
    ),
    { input: 0, output: 0, cacheRead: 0, cost: 0 }
  )
  assert.equal(
    parseUsage({ usage: { input_tokens: -1, output_tokens: 'unknown' } }, 'responses'),
    null
  )
  assert.equal(parseUsage({ choices: [] }, 'chat-completions'), null)
})

test('流式开始与结束用量合并，重复累计输出不重复累加，字节透传不变', async () => {
  let usage: TokenUsage = {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    cost: null
  }
  const stream = new ResponseIdsObserver(
    true,
    () => {},
    'messages',
    (partial) => {
      usage = { ...usage, ...partial }
    }
  )
  const chunks: Buffer[] = []
  stream.on('data', (chunk) => chunks.push(chunk))
  const end = once(stream, 'end')
  const body = [
    {
      message: {
        usage: {
          input_tokens: 20,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 80
        }
      }
    },
    { usage: { output_tokens: 10 } },
    { usage: { output_tokens: 30 } },
    { usage: { output_tokens: 30 } }
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  for (let i = 0; i < body.length; i += 7) stream.write(body.slice(i, i + 7))
  stream.end()
  await end
  assert.equal(Buffer.concat(chunks).toString(), body)
  assert.deepEqual(usage, { input: 20, output: 30, cacheRead: 80, cacheWrite: 0, cost: null })
})

test('用量按完整历史汇总、筛选和时间分桶，重启保留，未知费用不计为零', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-stats-'))
  const file = join(dir, 'history.sqlite')
  let history = new RequestHistory(file)
  const start = new Date(2026, 8, 15).getTime()
  const query = { start, end: start + 86400000, bucketMs: 3600000 }
  try {
    for (let i = 0; i < 30; i++)
      history.append({
        id: String(i),
        time: start + i * 3600000,
        group: '',
        account: 'A',
        accountId: 'a',
        protocol: 'responses',
        model: 'k3',
        status: 200,
        attempts: 1,
        durationMs: 100,
        firstTokenMs: 20,
        usage: { input: 20, output: 10, cacheRead: 80, cacheWrite: null, cost: null }
      })
    history.append({
      id: 'old',
      time: start,
      group: '',
      account: 'B',
      accountId: 'b',
      model: 'old-model',
      status: 200,
      attempts: 1,
      durationMs: 50,
      firstTokenMs: null
    })
    const result = history.usage(query)
    assert.equal(result.summary.requests, 25)
    assert.equal(result.summary.reported, 24)
    assert.equal(result.summary.totalTokens, 2640)
    assert.equal(result.summary.cacheHitRate, 0.8)
    assert.equal(result.summary.cost, null)
    assert.equal(result.summary.cacheWrite, null)
    assert.equal(result.points.length, 24)
    assert.equal(result.points[0].requests, 2)
    assert.equal(
      history.usage({ ...query, accountId: 'a', model: 'k3', protocol: 'responses' }).summary
        .requests,
      24
    )
    assert.equal(history.usage({ ...query, accountId: 'b' }).summary.totalTokens, null)
    assert.equal(history.usage({ ...query, model: 'missing' }).summary.requests, 0)
    history.close()
    history = new RequestHistory(file)
    assert.equal(history.usage(query).summary.totalTokens, 2640)
    assert.throws(() => history.usage({ ...query, bucketMs: 1 }))
    assert.throws(() => history.usage({ ...query, end: start - 1 }))
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('平均速度按有效流式时长加权，中断数量和已报告消耗单独汇总', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-performance-'))
  const history = new RequestHistory(join(dir, 'history.sqlite'))
  const start = new Date(2026, 8, 16).getTime()
  const base = {
    time: start,
    group: '',
    account: 'A',
    accountId: 'account-a',
    model: 'k3',
    status: 200,
    attempts: 1,
    durationMs: 12000,
    firstTokenMs: 500
  }
  const usage = (output: number) => ({
    input: 20,
    output,
    cacheRead: 80,
    cacheWrite: null,
    cost: null
  })
  try {
    history.append({ ...base, id: 'a', streamDurationMs: 1000, usage: usage(100) })
    history.append({ ...base, id: 'b', streamDurationMs: 9000, usage: usage(200) })
    history.append({ ...base, id: 'non-stream', usage: usage(1000) })
    history.append({ ...base, id: 'unknown', streamDurationMs: 5000 })
    history.append({
      ...base,
      id: 'cancelled',
      status: 499,
      streamDurationMs: 2000,
      usage: { ...usage(50), cost: 0.01 }
    })
    history.append({ ...base, id: 'cancelled-unknown', status: 499 })
    const result = history.usage({ start, end: start + 86400000, bucketMs: 3600000 })
    assert.equal(result.summary.averageTokensPerSecond, 30)
    assert.equal(result.summary.speedSamples, 2)
    assert.equal(result.summary.interruptedRequests, 2)
    assert.equal(result.summary.interruptedReported, 1)
    assert.equal(result.summary.interruptedTokens, 150)
    assert.equal(result.summary.interruptedCost, 0.01)
    assert.equal(result.byModel[0].averageTokensPerSecond, 30)
    assert.equal(result.points[0].interruptedRequests, 2)
    history.append({
      ...base,
      id: 'other-account',
      accountId: 'account-b',
      streamDurationMs: 3000,
      usage: usage(900)
    })
    const byAccount = history.usage({ start, end: start + 86400000, bucketMs: 3600000 }).byAccount
    assert.deepEqual(
      byAccount.find((a) => a.accountId === 'account-a'),
      { accountId: 'account-a', averageTokensPerSecond: 30, speedSamples: 2 }
    )
    assert.deepEqual(
      byAccount.find((a) => a.accountId === 'account-b'),
      { accountId: 'account-b', averageTokensPerSecond: 300, speedSamples: 1 }
    )
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('热力图使用 112 个本地自然日，日期边界与未知用量分级正确', async () => {
  const now = new Date(2026, 0, 2, 13).getTime()
  const range = heatmapRange(now)
  const dates: string[] = []
  for (
    const date = new Date(range.start);
    date.getTime() < range.end;
    date.setDate(date.getDate() + 1)
  )
    dates.push(localDayKey(date.getTime()))
  assert.equal(dates.length, 112)
  assert.equal(dates.at(-1), '2026-01-02')
  assert.equal(heatmapLevel(null, 100), 0)
  assert.equal(heatmapLevel(0, 100), 0)
  assert.equal(heatmapLevel(25, 100), 1)
  assert.equal(heatmapLevel(100, 100), 4)
  const dir = await mkdtemp(join(tmpdir(), 'kimi-calendar-'))
  const history = new RequestHistory(join(dir, 'history.sqlite'))
  try {
    const time = new Date(2026, 0, 1, 23, 59, 59).getTime()
    const record = {
      id: 'before',
      time,
      group: '',
      account: 'a',
      model: 'k3',
      status: 200,
      attempts: 1,
      durationMs: 100,
      firstTokenMs: 10
    }
    history.append(record)
    history.append({ ...record, id: 'after', time: time + 1000 })
    const result = history.usage({ ...range, bucketMs: 86400000 })
    assert.equal(result.points.length, 112)
    assert.equal(result.points.at(-2)!.requests, 1)
    assert.equal(result.points.at(-1)!.requests, 1)
    assert.equal(result.points.at(-1)!.totalTokens, null)
  } finally {
    history.close()
    await rm(dir, { recursive: true, force: true })
  }
})
