import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountInput } from '../src/shared/contracts'
import {
  GatewayStore,
  capabilityFields,
  type SecretCodec,
  type StoredAccount,
  type StoredGroup
} from '../src/main/services/gateway-store'
import { Gateway } from '../src/main/services/gateway'
import { Scheduler } from '../src/main/services/scheduler'
import { KimiCapabilities, reportedConcurrency } from '../src/main/services/kimi-capabilities'
import { parseKimiQuota, quotaWindow } from '../src/shared/kimi-quota'

// 测试使用独立随机密钥，生产环境的系统加密另由 Electron 冒烟测试覆盖。
function codec(): SecretCodec {
  const key = randomBytes(32)
  return {
    encrypt(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
    },
    decrypt(value) {
      const buf = Buffer.from(value, 'base64'),
        cipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
      cipher.setAuthTag(buf.subarray(12, 28))
      return Buffer.concat([cipher.update(buf.subarray(28)), cipher.final()]).toString('utf8')
    }
  }
}
const accountInput = (name: string, groupId = 'default'): AccountInput => ({
  name,
  kind: 'api-key',
  region: 'mainland-cn',
  enabled: true,
  memberships: [{ groupId, priority: 0, weight: 1 }],
  secret: `secret-${name}`
})
const group: StoredGroup = {
  id: 'default',
  name: '默认分组',
  enabled: true,
  strategy: 'balanced',
  stickySeconds: 300,
  key: 'test-key'
}
function account(id: string, weight = 1, priority = 0): StoredAccount {
  const { secret: _secret, ...input } = accountInput(id)
  return {
    ...input,
    ...capabilityFields(input.region, {
      models: ['model', 'm', 'kimi-for-coding'],
      maxConcurrency: 2,
      checkedAt: Date.now(),
      warning: ''
    }),
    id,
    memberships: [{ groupId: group.id, priority, weight }],
    credential: { accessToken: `secret-${id}` }
  }
}
async function storeFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-gateway-test-'))
  const file = join(dir, 'gateway.json'),
    secrets = codec(),
    store = new GatewayStore(file, secrets)
  await store.load()
  return { store, file, secrets, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(check(), '等待异步清理完成')
}
async function gatewayFixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  names = ['a', 'b']
) {
  const fixture = await storeFixture()
  const upstream = await listen(handler)
  const reserved = await listen((_req, res) => res.end())
  const port = reserved.port
  await reserved.close()
  const gateway = new Gateway(
    fixture.store,
    (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://api.kimi.com')
      return fetch(upstream.url + url.pathname + url.search, init)
    },
    async () => Response.json({ data: [{ id: 'kimi-for-coding' }], max_concurrency: 2 })
  )
  await gateway.saveSettings({
    ...fixture.store.get().settings,
    port,
    maxAttempts: 3,
    cooldownSeconds: 1
  })
  for (const name of names) await gateway.saveAccount(accountInput(name))
  await gateway.setRunning(true)
  const url = `http://127.0.0.1:${port}`
  const key = fixture.store.get().groups[0].key
  const post = (
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    path = '/v1/chat/completions'
  ) =>
    fetch(url + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        model: 'kimi-for-coding',
        messages: [{ role: 'user', content: 'test' }],
        ...body
      })
    })
  return {
    ...fixture,
    upstream,
    gateway,
    url,
    key,
    post,
    cleanup: async () => {
      await gateway.shutdown()
      gateway.history.close()
      await upstream.close()
      await fixture.cleanup()
    }
  }
}

test('额度未知时均衡分配，旧权重和优先级不干预，会话保持和冷却有效', () => {
  let now = 1000
  const scheduler = new Scheduler(() => now)
  const accounts = [account('a', 1), account('b', 3), account('c', 6), account('backup', 100, 1)]
  const counts: Record<string, number> = {}
  for (let i = 0; i < 100; i++) {
    const lease = scheduler.acquire(accounts, group, 'model', '', new Set())!
    counts[lease.account.id] = (counts[lease.account.id] ?? 0) + 1
    lease.release()
    lease.release()
  }
  assert.deepEqual(counts, { a: 25, b: 25, c: 25, backup: 25 })
  const first = scheduler.acquire(accounts, group, 'model', 'session', new Set())!
  first.release()
  const next = scheduler.acquire(accounts, group, 'model', 'session', new Set())!
  assert.equal(first.account.id, next.account.id)
  next.release()
  scheduler.failure(first.account.id, 429, 30, '60')
  const fallback = scheduler.acquire(accounts, group, 'model', 'session', new Set())!
  assert.notEqual(fallback.account.id, first.account.id)
  fallback.release()
  assert.equal(scheduler.state(first.account.id).cooldownUntil, now + 60000)
  now += 61000
  assert.ok(
    scheduler.acquire(
      accounts,
      group,
      'model',
      '',
      new Set(accounts.filter((a) => a.id !== first.account.id).map((a) => a.id))
    )
  )
})

test('筛选停用、模型不匹配、认证失败、并发满载；跨分组共用槽位', () => {
  const scheduler = new Scheduler()
  const a = account('a'),
    b = account('b', 1, 1)
  a.maxConcurrency = 1
  a.memberships.push({ groupId: 'other', priority: 0, weight: 1 })
  const lease = scheduler.acquire([a], group, 'm', '', new Set())!
  assert.equal(lease.account.id, 'a')
  assert.equal(scheduler.acquire([a], { ...group, id: 'other' }, 'm', '', new Set()), undefined)
  const backup = scheduler.acquire([a, b], group, 'm', '', new Set())!
  assert.equal(backup.account.id, 'b')
  backup.release()
  lease.release()
  a.models = ['only']
  assert.equal(scheduler.acquire([a], group, 'm', '', new Set()), undefined)
  a.models = ['m']
  a.enabled = false
  assert.equal(scheduler.acquire([a], group, 'm', '', new Set()), undefined)
  a.enabled = true
  scheduler.failure(a.id, 401, 10)
  scheduler.success(a.id, 10)
  assert.equal(scheduler.acquire([a], group, 'm', '', new Set()), undefined)
  scheduler.reset(a.id)
  assert.ok(scheduler.acquire([a], group, 'm', '', new Set()))
})

test('相同额度按并发分散，满载时不会超卖', () => {
  const scheduler = new Scheduler()
  const accounts = [account('a'), account('b', 2)]
  const leases = Array.from({ length: 4 }, () =>
    scheduler.acquire(accounts, group, 'm', '', new Set())!
  )
  assert.equal(leases[0].account.id, 'a')
  assert.equal(leases[1].account.id, 'b')
  assert.equal(leases[2].account.id, 'a')
  assert.equal(scheduler.acquire(accounts, group, 'm', '', new Set()), undefined)
  leases.forEach((l) => l.release())
  assert.equal(scheduler.state('a').active + scheduler.state('b').active, 0)
})

function setQuota(
  a: StoredAccount,
  five: number | null,
  week: number | null,
  now: number,
  limit = 100
): void {
  const window = (remaining: number | null) =>
    remaining === null
      ? null
      : {
          remaining,
          limit,
          used: limit - remaining,
          resetAt: new Date(now + 3600000).toISOString()
        }
  a.capabilities = {
    ...a.capabilities!,
    checkedAt: now,
    quota: {
      fiveHour: window(five),
      weekly: window(week),
      total: null,
      totalUnlimited: true
    }
  }
}

test('评分使用并发上限、已占用并发、两个窗口的剩余比例', () => {
  const now = Date.now()
  const scheduler = new Scheduler(() => now)
  const a = account('a'),
    b = account('b')
  a.maxConcurrency = b.maxConcurrency = 20
  setQuota(a, 90, 90, now)
  setQuota(b, 40, 40, now)
  const pick = () => {
    const lease = scheduler.acquire([a, b], group, 'm', '', new Set())!
    lease.release()
    return lease.account.id
  }
  assert.equal(pick(), 'a')
  scheduler.state('a').active = 18
  assert.equal(pick(), 'b') // 并发压力足够高时让出新会话。
  scheduler.state('a').active = 0
  setQuota(a, 90, 10, now)
  setQuota(b, 60, 60, now)
  assert.equal(pick(), 'b') // 7D 余量也参与评分。
  setQuota(a, 10, 90, now)
  assert.equal(pick(), 'b') // 5h 余量也参与评分。
  setQuota(a, 60, 60, now)
  b.maxConcurrency = 40
  assert.equal(pick(), 'b') // 按上限归一化。
  b.maxConcurrency = 20
  setQuota(a, 120, 120, now, 200)
  setQuota(b, 70, 70, now)
  assert.equal(pick(), 'b') // 比较百分比，而不是额度绝对值。
})

test('同容量新会话分散并发，两个窗口剩余百分比随消耗收敛', () => {
  let now = Date.now()
  const scheduler = new Scheduler(() => now)
  const a = account('a'),
    b = account('b')
  a.maxConcurrency = b.maxConcurrency = 20
  setQuota(a, 80, 80, now)
  setQuota(b, 80, 80, now)
  const leases = Array.from({ length: 20 }, (_, i) =>
    scheduler.acquire([a, b], group, 'm', `new-${i}`, new Set())!
  )
  assert.equal(scheduler.state('a').active, 10)
  assert.equal(scheduler.state('b').active, 10)
  leases.forEach((l) => l.release())
  setQuota(a, 90, 90, now)
  setQuota(b, 40, 40, now)
  for (let i = 0; i < 100; i++) {
    const lease = scheduler.acquire([a, b], group, 'm', '', new Set())!
    const remaining = lease.account.capabilities!.quota!.fiveHour!.remaining! - 1
    lease.release()
    setQuota(lease.account, remaining, remaining, ++now)
  }
  assert.equal(a.capabilities!.quota!.fiveHour!.remaining, 15)
  assert.equal(b.capabilities!.quota!.weekly!.remaining, 15)
})

test('粘性绑定优先于额度与并发评分，满载或任一窗口耗尽才重新分配', () => {
  const now = Date.now()
  const scheduler = new Scheduler(() => now)
  const a = account('a'),
    b = account('b')
  a.maxConcurrency = b.maxConcurrency = 20
  setQuota(a, 90, 90, now)
  setQuota(b, 80, 80, now)
  const pick = (session: string) => {
    const lease = scheduler.acquire([a, b], group, 'm', session, new Set())!
    lease.release()
    return lease.account.id
  }
  assert.equal(pick('session'), 'a')
  setQuota(a, 10, 10, now)
  scheduler.state('a').active = 18
  assert.equal(pick('session'), 'a')
  assert.equal(pick('new'), 'b')
  scheduler.state('a').active = 20
  assert.equal(pick('session'), 'b')
  scheduler.state('a').active = 0
  setQuota(b, 0, 80, now)
  assert.equal(pick('session'), 'a')
  setQuota(a, 10, 0, now)
  assert.equal(scheduler.acquire([a, b], group, 'm', 'session', new Set()), undefined)
})

test('额度缺失、陈旧和窗口重置时不伪造满额，也不永久锁死旧的零额度', () => {
  let now = Date.now()
  const scheduler = new Scheduler(() => now)
  const a = account('a'),
    b = account('b')
  setQuota(a, 0, 80, now)
  setQuota(b, 40, null, now)
  assert.equal(scheduler.acquire([a], group, 'm', '', new Set()), undefined)
  now += 120001
  const expired = scheduler.acquire([a], group, 'm', '', new Set())!
  assert.ok(expired)
  expired.release()
  setQuota(a, 0, 80, now)
  a.capabilities!.quota!.fiveHour!.resetAt = new Date(now - 1).toISOString()
  const reset = scheduler.acquire([a], group, 'm', '', new Set())!
  assert.ok(reset)
  reset.release()
  setQuota(a, null, null, now)
  setQuota(b, 10, 10, now)
  const leases = Array.from({ length: 4 }, () =>
    scheduler.acquire([a, b], group, 'm', '', new Set())!
  )
  assert.equal(scheduler.state('a').active, 2)
  assert.equal(scheduler.state('b').active, 2)
  leases.forEach((l) => l.release())
})

test('后台额度刷新合并调用，保留粘性、手动并发、冷却及认证失败；失败不伪造新鲜额度', async () => {
  const f = await storeFixture()
  let failUsage = false
  let calls = 0
  const metadata: typeof fetch = async (url) => {
    calls++
    return String(url).endsWith('/models')
      ? Response.json({ data: [{ id: 'm' }] })
      : failUsage
        ? Response.json({}, { status: 503 })
        : Response.json({
            parallel: { limit: 30 },
            usage: { limit: 100, remaining: 60 },
            limits: [
              { window: { duration: 5, timeUnit: 'HOUR' }, detail: { limit: 100, remaining: 80 } }
            ]
          })
  }
  const gateway = new Gateway(f.store, metadata)
  try {
    const a = account('a'),
      b = account('b')
    setQuota(a, 90, 90, Date.now() - 60000)
    setQuota(b, 40, 40, Date.now() - 60000)
    const aId = await f.store.saveAccount(
      { ...accountInput('a'), concurrencyOverride: 20 },
      a.capabilities!
    )
    const bId = await f.store.saveAccount(accountInput('b'), b.capabilities!)
    const pick = () => {
      const data = f.store.get()
      const lease = gateway.scheduler.acquire(
        data.accounts,
        data.groups[0],
        'm',
        'sticky',
        new Set()
      )!
      lease.release()
      return lease.account.id
    }
    assert.equal(pick(), aId)
    gateway.scheduler.failure(bId, 401, 30)
    gateway.scheduler.failure(bId, 429, 30, '60')
    const cooldown = gateway.scheduler.state(bId).cooldownUntil
    await Promise.all([gateway.refreshStaleAccounts(), gateway.refreshStaleAccounts()])
    assert.equal(calls, 4)
    assert.equal(gateway.scheduler.state(bId).authFailed, true)
    assert.equal(gateway.scheduler.state(bId).cooldownUntil, cooldown)
    assert.equal(f.store.get().accounts.find((a) => a.id === aId)!.maxConcurrency, 20)
    gateway.scheduler.reset(bId)
    // 使另一个账号的新会话得分更高，仍应保留原绑定。
    gateway.scheduler.state(aId).active = 18
    assert.equal(pick(), aId)
    await gateway.refreshAccount(aId)
    assert.equal(pick(), aId) // 手动刷新同样不能打断粘性缓存。
    gateway.scheduler.state(aId).active = 0
    const oldTime = Date.now() - 60000
    await f.store.mutate((data) => {
      for (const a of data.accounts) a.capabilities!.checkedAt = oldTime
    })
    const before = f.store.get().accounts[0].capabilities!.quota
    failUsage = true
    await gateway.refreshStaleAccounts()
    assert.equal(f.store.get().accounts[0].capabilities!.checkedAt, oldTime)
    assert.deepEqual(f.store.get().accounts[0].capabilities!.quota, before)
    assert.match(f.store.get().accounts[0].capabilities!.warning, /503/)
  } finally {
    await f.cleanup()
  }
})

test('账号分组串行落盘、加密、校验和损坏保护', async () => {
  const f = await storeFixture()
  try {
    await Promise.all([
      f.store.saveAccount(accountInput('a')),
      f.store.saveAccount(accountInput('b'))
    ])
    assert.equal(f.store.get().accounts.length, 2)
    const raw = await readFile(f.file, 'utf8')
    assert.ok(!raw.includes('secret-a'))
    const restored = new GatewayStore(f.file, f.secrets)
    await restored.load()
    assert.equal(restored.get().accounts[0].credential.accessToken, 'secret-a')
    const old = restored.get().accounts[0]
    await restored.saveAccount({ ...old, name: 'renamed', secret: '' })
    assert.equal(restored.get().accounts[0].credential.accessToken, 'secret-a')
    for (const invalid of [
      { memberships: [] },
      { secret: 'abc\nxyz' },
      { enabled: 'true' },
      { memberships: [{ groupId: 'missing', priority: 0, weight: 1 }] }
    ]) {
      await assert.rejects(restored.saveAccount({ ...accountInput('bad'), ...invalid }))
    }
    await restored.saveGroup({
      name: '独立组',
      enabled: true,
      strategy: 'least-connections',
      stickySeconds: 0
    })
    const other = restored.get().groups[1]
    assert.equal(other.strategy, 'balanced') // 旧策略输入自动迁移。
    await restored.saveAccount(accountInput('c', other.id))
    await assert.rejects(restored.deleteGroup(other.id), /关联/)
    await assert.rejects(restored.deleteGroup('default'), /默认/)
    await writeFile(f.file, 'broken')
    await assert.rejects(new GatewayStore(f.file, f.secrets).load(), /原文件已保留/)
    assert.equal(await readFile(f.file, 'utf8'), 'broken')
  } finally {
    await f.cleanup()
  }
})

test('真实 HTTP 转发、分组密钥隔离与会话保持，凭据不出现在快照', async () => {
  const received: { auth: string; url: string; body: string; localKey?: string }[] = []
  const f = await gatewayFixture((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      received.push({
        auth: req.headers.authorization ?? '',
        url: req.url ?? '',
        body,
        localKey: req.headers['x-api-key'] as string | undefined
      })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  try {
    for (let i = 0; i < 4; i++) {
      const r = await f.post()
      assert.equal(r.status, 200)
      await r.text()
    }
    assert.deepEqual(
      received.map((r) => r.auth),
      ['Bearer secret-a', 'Bearer secret-b', 'Bearer secret-a', 'Bearer secret-b']
    )
    assert.equal(received[0].url, '/coding/v1/chat/completions')
    assert.equal(received[0].localKey, undefined)
    const snapshot = JSON.stringify(f.gateway.snapshot())
    assert.ok(!snapshot.includes('secret-a'))
    assert.ok(!snapshot.includes(f.key))
    for (let i = 0; i < 3; i++) await (await f.post({}, { 'x-session-id': 'session-1' })).text()
    assert.equal(new Set(received.slice(-3).map((r) => r.auth)).size, 1)
    assert.equal((await f.post({}, { authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await f.post({}, { origin: 'https://evil.example' })).status, 403)
    await f.store.saveGroup({
      name: 'other',
      enabled: true,
      strategy: 'weighted-round-robin',
      stickySeconds: 0
    })
    const other = f.store.get().groups[1]
    assert.equal((await f.post({}, {}, `/groups/${other.id}/v1/chat/completions`)).status, 401)
    const legacy = await f.post({}, { authorization: `Bearer ${other.key}` })
    assert.equal(legacy.status, 200)
    await legacy.text()
    assert.equal((await f.post({}, {}, '/v1/not-supported')).status, 404)
    assert.equal((await f.post({ model: 12 })).status, 400)
    const anthropic = await f.post({}, { 'x-api-key': f.key, authorization: '' }, '/v1/messages')
    await anthropic.text()
    assert.equal(anthropic.status, 200)
    assert.equal(received.at(-1)?.url, '/coding/v1/messages')
    assert.equal(received.at(-1)?.localKey, undefined)
    assert.equal(
      f.gateway.snapshot().accounts.reduce((n, a) => n + a.runtime.active, 0),
      0
    )
  } finally {
    await f.cleanup()
  }
})

test('Responses、Chat Completions、Messages 原路径、请求体及 JSON/SSE 响应透传', async () => {
  const received: { url: string; body: string; auth: string | undefined }[] = []
  let streaming = false
  const json = '{ "id": "upstream-id", "output": [{"type":"function_call","arguments":"{}"}] }'
  const sse =
    'event: response.output_text.delta\ndata: {"delta":"hello"}\n\nevent: response.completed\ndata: {"response":{"id":"upstream-id"}}\n\n'
  const f = await gatewayFixture((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        url: req.url!,
        body: Buffer.concat(chunks).toString(),
        auth: req.headers.authorization
      })
      res.writeHead(200, {
        'content-type': streaming ? 'text/event-stream' : 'application/json',
        'x-request-id': 'upstream-trace'
      })
      if (streaming) {
        res.write(sse.slice(0, 45))
        res.end(sse.slice(45))
      } else res.end(json)
    })
  })
  try {
    for (const route of ['responses', 'chat/completions', 'messages']) {
      for (const stream of [false, true]) {
        streaming = stream
        const payload =
          route === 'responses'
            ? {
                input: [{ role: 'user', content: 'hello' }],
                previous_response_id: 'previous',
                tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }]
              }
            : { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 }
        const reasoning =
          route === 'responses'
            ? { reasoning: { effort: 'high' } }
            : route === 'chat/completions'
              ? { reasoning_effort: 'low' }
              : { output_config: { effort: 'medium' } }
        const body = JSON.stringify(
          { model: 'kimi-for-coding', stream, ...payload, ...reasoning },
          null,
          2
        )
        const response = await fetch(`${f.url}/groups/default/v1/${route}?trace=1`, {
          method: 'POST',
          headers: { authorization: `Bearer ${f.key}`, 'content-type': 'application/json' },
          body
        })
        assert.equal(response.status, 200)
        assert.equal(await response.text(), stream ? sse : json)
        assert.equal(response.headers.get('x-request-id'), 'upstream-trace')
        assert.equal(received.at(-1)!.url, `/coding/v1/${route}?trace=1`)
        assert.equal(received.at(-1)!.body, body)
        assert.match(received.at(-1)!.auth!, /^Bearer secret-[ab]$/)
      }
    }
    assert.equal(received.length, 6)
    await eventually(() => f.gateway.snapshot().requests.length === 6)
    assert.ok(f.gateway.snapshot().requests.every((r) => r.upstreamRequestId === 'upstream-trace'))
    assert.deepEqual(
      f.gateway.snapshot().requests.map((r) => r.reasoningEffort),
      ['medium', 'medium', 'low', 'low', 'high', 'high']
    )
    await f.gateway.setRunning(false)
    const restored = new Gateway(f.store)
    assert.equal(restored.snapshot().requests.length, 6)
    assert.equal(restored.snapshot().requests[0].upstreamRequestId, 'upstream-trace')
    assert.equal(restored.snapshot().requests[0].reasoningEffort, 'medium')
    restored.history.close()
  } finally {
    await f.cleanup()
  }
})

test('429 冷却并切换；400 原样返回且不重试；503 耗尽有界退出', async () => {
  let mode = 'rate',
    calls = 0
  const f = await gatewayFixture((req, res) => {
    calls++
    const status =
      mode === 'rate'
        ? req.headers.authorization === 'Bearer secret-a'
          ? 429
          : 200
        : mode === 'bad'
          ? 400
          : 503
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '60' })
    res.end(JSON.stringify({ marker: 'upstream' }))
  })
  try {
    assert.equal((await f.post()).status, 200)
    assert.equal(calls, 2)
    const a = f.gateway.snapshot().accounts.find((a) => a.name === 'a')!
    assert.ok(a.runtime.cooldownUntil > Date.now() + 50000)
    mode = 'bad'
    const response = await f.post()
    assert.equal(response.status, 400)
    assert.equal(calls, 3)
    assert.deepEqual(await response.json(), { marker: 'upstream' })
    mode = 'fail'
    f.gateway.scheduler.reset(a.id)
    assert.equal((await f.post()).status, 503)
    assert.equal(calls, 5)
    assert.equal(f.gateway.snapshot().requests[0].attempts, 2)
    assert.equal((await f.post()).status, 503)
    assert.equal(calls, 5)
  } finally {
    await f.cleanup()
  }
})

test('首 token 从请求开始计时并包含重试，跳过响应头和初始化帧，总耗时单独记录', async () => {
  let calls = 0
  const preamble = ': heartbeat\n\nevent: response.created\ndata: {"type":"response.created"}\n\n'
  const token =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'
  const f = await gatewayFixture((_req, res) => {
    if (++calls === 1) {
      setTimeout(() => {
        res.writeHead(429)
        res.end('{}')
      }, 40)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(preamble)
    setTimeout(() => {
      res.write(token)
      setTimeout(() => res.end('data: [DONE]\n\n'), 50)
    }, 60)
  })
  try {
    const response = await f.post({ stream: true }, {}, '/v1/responses')
    assert.equal(await response.text(), preamble + token + 'data: [DONE]\n\n')
    await eventually(() => f.gateway.snapshot().requests.length === 1)
    const record = f.gateway.snapshot().requests[0]
    assert.equal(record.attempts, 2)
    assert.ok(record.firstTokenMs !== null && record.firstTokenMs >= 80)
    assert.ok(record.durationMs >= record.firstTokenMs + 30)
  } finally {
    await f.cleanup()
  }
})

test('流式 SSE 原样到达，客户端断开释放槽位，输出后不重试', async () => {
  let calls = 0
  const f = await gatewayFixture((_req, res) => {
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 100)
    res.on('close', () => clearTimeout(timer))
  })
  try {
    const response = await f.post({ stream: true })
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(
      await response.text(),
      'event: message_start\ndata: {"type":"message_start"}\n\ndata: [DONE]\n\n'
    )
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `${f.url}/v1/chat/completions`,
        { method: 'POST', headers: { authorization: `Bearer ${f.key}` } },
        (res) => {
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ model: 'kimi-for-coding', stream: true }))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(calls, 2)
    assert.equal(f.gateway.snapshot().requests[0].interruption, 'client_disconnect')
    assert.equal(
      f.gateway.snapshot().accounts.reduce((n, a) => n + a.runtime.active, 0),
      0
    )
    assert.equal(
      f.gateway.snapshot().accounts.reduce((n, a) => n + a.runtime.failures, 0),
      0
    )
  } finally {
    await f.cleanup()
  }
})

test('流式中断不进行第二次生成，记录失败并释放并发', async () => {
  let calls = 0
  const f = await gatewayFixture((_req, res) => {
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: partial\n\n')
    setTimeout(() => res.destroy(), 30)
  })
  try {
    const response = await f.post({ stream: true })
    await assert.rejects(response.text())
    await eventually(() => f.gateway.snapshot().accounts.every((a) => a.runtime.active === 0))
    assert.equal(calls, 1)
    assert.equal(f.gateway.snapshot().requests[0].interruption, 'upstream_disconnect')
    assert.equal(
      f.gateway.snapshot().accounts.reduce((n, a) => n + a.runtime.active, 0),
      0
    )
    assert.equal(
      f.gateway.snapshot().accounts.reduce((n, a) => n + a.runtime.failures, 0),
      1
    )
  } finally {
    await f.cleanup()
  }
})

test('网关识别缺少结束事件和流内错误，并按已报告用量计量；正常结束与 token 上限不误报', async () => {
  for (const mode of ['truncated', 'error', 'complete', 'limit'] as const) {
    const prefix =
      'data: {"type":"response.output_text.delta","delta":"hello","usage":{"input_tokens":10,"output_tokens":3,"input_tokens_details":{"cached_tokens":5}}}\n\n'
    const suffix =
      mode === 'truncated'
        ? ''
        : mode === 'error'
          ? 'event: error\ndata: {"error":{"message":"upstream stopped"}}\n\n'
          : mode === 'limit'
            ? 'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n'
            : 'data: {"type":"response.completed"}\n\n'
    const f = await gatewayFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(prefix + suffix)
    })
    try {
      const response = await f.post({ stream: true }, {}, '/v1/responses')
      assert.equal(await response.text(), prefix + suffix)
      await eventually(() => f.gateway.snapshot().requests.length === 1)
      const record = f.gateway.snapshot().requests[0]
      const interrupted = mode === 'truncated' || mode === 'error'
      assert.equal(
        record.interruption,
        mode === 'truncated' ? 'upstream_disconnect' : mode === 'error' ? 'upstream_error' : null
      )
      assert.equal(record.attempts, 1)
      assert.equal(record.status, interrupted ? 502 : 200)
      const totals = f.gateway.history.usage({
        start: Date.now() - 60000,
        end: Date.now() + 60000,
        bucketMs: 3600000
      }).summary
      assert.equal(totals.interruptedRequests, interrupted ? 1 : 0)
      assert.equal(totals.interruptedTokens, interrupted ? 13 : null)
      assert.equal(totals.interruptionCounts.upstream, interrupted ? 1 : 0)
    } finally {
      await f.cleanup()
    }
  }
})

test('有请求时禁止停止网关，全部流式请求结束后恢复；退出仍可清理在途请求', async () => {
  const responses: ServerResponse[] = []
  const f = await gatewayFixture((_req, res) => {
    responses.push(res)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': heartbeat\n\n')
  })
  try {
    const first = await f.post({ stream: true })
    const second = await f.post({ stream: true })
    assert.equal(f.gateway.snapshot().activeRequestCount, 2)
    await assert.rejects(f.gateway.setRunning(false), /网关使用中，请在请求结束后重试/)
    assert.equal(f.gateway.snapshot().running, true)
    responses[0].end('data: [DONE]\n\n')
    await first.text()
    await eventually(() => f.gateway.snapshot().activeRequestCount === 1)
    await assert.rejects(f.gateway.setRunning(false), /网关使用中/)
    responses[1].end('data: [DONE]\n\n')
    await second.text()
    await eventually(() => f.gateway.snapshot().activeRequestCount === 0)
    await f.gateway.setRunning(false)
    assert.equal(f.gateway.snapshot().running, false)
    await f.gateway.setRunning(true)
    const third = await f.post({ stream: true })
    const consumed = third.text().catch(() => '')
    await f.gateway.shutdown()
    await consumed
    assert.equal(f.gateway.snapshot().activeRequestCount, 0)
    assert.equal(f.gateway.snapshot().requests[0].interruption, 'gateway_shutdown')
  } finally {
    await f.cleanup()
  }
})

test('并发请求不超卖，配置变更不破坏在途请求，网关可重复启停', async () => {
  const responses: ServerResponse[] = []
  const f = await gatewayFixture(
    (_req, res) => {
      responses.push(res)
    },
    ['a']
  )
  try {
    const a = f.store.get().accounts[0]
    await f.store.saveAccount(a, { ...a.capabilities!, maxConcurrency: 1 })
    const first = f.post()
    while (!responses.length) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await f.post()).status, 503)
    await f.gateway.saveAccount({ ...a, enabled: false })
    responses[0].end('{"ok":true}')
    assert.equal((await first).status, 200)
    assert.equal((await f.post()).status, 503)
    await assert.rejects(
      f.gateway.saveSettings({ ...f.store.get().settings, port: f.store.get().settings.port + 1 }),
      /停止/
    )
    await Promise.all([f.gateway.setRunning(false), f.gateway.setRunning(true)])
    assert.equal(f.gateway.snapshot().running, true)
  } finally {
    await f.cleanup()
  }
})

test('请求体大小、方法校验和上游重定向限制', async () => {
  let redirected = 0,
    calls = 0
  const target = await listen((_req, res) => {
    redirected++
    res.end('unexpected')
  })
  const f = await gatewayFixture((_req, res) => {
    calls++
    res.writeHead(307, { location: target.url })
    res.end()
  })
  try {
    assert.equal(
      (await f.post({ messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] })).status,
      413
    )
    assert.equal(calls, 0)
    assert.equal(
      (
        await fetch(`${f.url}/v1/chat/completions`, {
          headers: { authorization: `Bearer ${f.key}` }
        })
      ).status,
      405
    )
    assert.equal((await f.post()).status, 503)
    assert.equal(calls, 2)
    assert.equal(redirected, 0)
  } finally {
    await f.cleanup()
    await target.close()
  }
})

test('仅接受 API Key，旧 OAuth 配置先备份再停用，不能转发旧令牌', async () => {
  const f = await storeFixture()
  try {
    await f.store.saveAccount(accountInput('existing-key'))
    await assert.rejects(
      f.store.saveAccount({ ...accountInput('unsupported'), kind: 'oauth' }),
      /仅支持 API Key/
    )
    const legacy = {
      ...account('legacy'),
      kind: 'oauth',
      credential: {
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        deviceId: 'old-device'
      }
    }
    const oldData = { ...f.store.get(), accounts: [...f.store.get().accounts, legacy] }
    const encrypted = JSON.stringify({
      version: 1,
      encrypted: f.secrets.encrypt(JSON.stringify(oldData))
    })
    await writeFile(f.file, encrypted)
    const restored = new GatewayStore(f.file, f.secrets)
    await restored.load()
    assert.equal(await readFile(`${f.file}.oauth-backup`, 'utf8'), encrypted)
    assert.equal(restored.get().accounts[0].credential.accessToken, 'secret-existing-key')
    const migrated = restored.get().accounts[1]
    assert.equal(migrated.kind, 'api-key')
    assert.equal(migrated.enabled, false)
    assert.deepEqual(migrated.credential, { accessToken: '' })
    assert.deepEqual(migrated.memberships, legacy.memberships)
    assert.equal(new Scheduler().acquire([migrated], group, 'm', '', new Set()), undefined)
    await assert.rejects(restored.saveAccount({ ...migrated, enabled: true }), /请填写 API Key/)
    await restored.saveAccount({ ...migrated, enabled: true, secret: 'replacement-api-key' })
    const reloaded = new GatewayStore(f.file, f.secrets)
    await reloaded.load()
    assert.equal(reloaded.get().accounts[1].credential.accessToken, 'replacement-api-key')
    assert.equal(reloaded.get().accounts[1].enabled, true)
    assert.equal(await readFile(`${f.file}.oauth-backup`, 'utf8'), encrypted)
  } finally {
    await f.cleanup()
  }
})

test('真实上游超时返回 504，释放槽位并记录冷却', async () => {
  const f = await gatewayFixture(() => {}, ['a'])
  try {
    await f.gateway.saveSettings({ ...f.store.get().settings, timeoutSeconds: 5 })
    const response = await f.post()
    assert.equal(response.status, 504)
    await response.text()
    assert.equal(f.gateway.snapshot().accounts[0].runtime.active, 0)
    assert.equal(f.gateway.snapshot().accounts[0].runtime.failures, 1)
    assert.ok(f.gateway.snapshot().accounts[0].runtime.cooldownUntil > Date.now())
    assert.equal(f.gateway.snapshot().requests[0].status, 504)
    assert.equal(f.gateway.snapshot().requests[0].interruption, 'timeout')
  } finally {
    await f.cleanup()
  }
})

test('启动端口冲突可恢复，密钥和端口设置保持一致', async () => {
  const f = await storeFixture()
  const occupied = await listen((_req, res) => res.end())
  const gateway = new Gateway(f.store)
  try {
    await gateway.saveSettings({ ...f.store.get().settings, port: occupied.port })
    const key = f.store.get().groups[0].key
    await assert.rejects(gateway.setRunning(true), /占用/)
    assert.equal(gateway.snapshot().running, false)
    assert.match(gateway.snapshot().error, /占用/)
    await occupied.close()
    await gateway.setRunning(true)
    assert.equal(gateway.snapshot().running, true)
    assert.equal(gateway.snapshot().error, '')
    assert.equal(f.store.get().groups[0].key, key)
  } finally {
    await gateway.setRunning(false)
    if (occupied.server.listening) await occupied.close()
    await f.cleanup()
  }
})

test('模型分页完整同步，不将用量、RPM 或上下文长度当作并发', async () => {
  const calls: string[] = []
  const capabilities = new KimiCapabilities(async (input, init) => {
    const url = String(input)
    calls.push(url)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer metadata-key')
    assert.equal(init?.redirect, 'error')
    if (url.endsWith('/usages'))
      return Response.json({
        usage: { limit: '100', remaining: '80' },
        limits: [{ detail: { limit: '200' } }]
      })
    if (url.includes('?after='))
      return Response.json({ data: [{ id: 'k3-256k' }], has_more: false })
    return Response.json(
      {
        data: [{ id: 'kimi-for-coding', context_length: 262144 }, { id: 'k3' }],
        has_more: true,
        last_id: 'k3'
      },
      { headers: { 'x-ratelimit-limit-requests': '30' } }
    )
  })
  const result = await capabilities.get('mainland-cn', 'metadata-key')
  assert.deepEqual(result.models, ['kimi-for-coding', 'k3', 'k3-256k'])
  assert.equal(result.maxConcurrency, null)
  assert.match(result.warning, /未获取到.*20 个并发/)
  assert.deepEqual(calls, [
    'https://api.kimi.com/coding/v1/models',
    'https://api.kimi.com/coding/v1/models?after=k3',
    'https://api.kimi.com/coding/v1/usages'
  ])
  assert.equal(
    reportedConcurrency(
      { usage: { limit: 100 }, concurrency: 'unknown', max_concurrency: -1 },
      new Headers()
    ),
    null
  )
  assert.equal(reportedConcurrency({ max_concurrency: 0 }, new Headers()), 0)
})

test('并发元数据采用明确字段，查询去重与缓存不暴露凭据', async () => {
  let calls = 0
  const capabilities = new KimiCapabilities(async (input) => {
    calls++
    if (String(input).endsWith('/usages'))
      return Response.json({
        usage: { limit: '100', used: '20', remaining: '80' },
        parallel: { limit: '8' }
      })
    assert.equal(String(input), 'https://api.kimi.ai/coding/v1/models')
    return Response.json(
      { data: [{ id: 'k3' }] },
      { headers: { 'x-ratelimit-limit-concurrency': '8' } }
    )
  })
  const results = await Promise.all(
    Array.from({ length: 3 }, () => capabilities.get('global', 'private-key'))
  )
  assert.equal(calls, 2)
  assert.equal(results[0].maxConcurrency, 8)
  assert.equal(results[0].warning, '')
  results[0].models.push('mutated')
  assert.deepEqual((await capabilities.get('global', 'private-key')).models, ['k3'])
  assert.ok(!JSON.stringify(results).includes('private-key'))
})

test('模型响应无效时拒绝保存，用量接口不可用时保留模型并明确提示', async () => {
  const invalid = new KimiCapabilities(async () => Response.json({ data: [{ no_id: 'missing' }] }))
  await assert.rejects(invalid.get('mainland-cn', 'key'), /模型 ID/)
  const partial = new KimiCapabilities(async (input) =>
    String(input).endsWith('/models')
      ? Response.json({ data: [{ id: 'kimi-for-coding' }] })
      : Response.json({ error: 'secret-should-not-be-echoed' }, { status: 503 })
  )
  const result = await partial.get('mainland-cn', 'key')
  assert.deepEqual(result.models, ['kimi-for-coding'])
  assert.equal(result.maxConcurrency, null)
  assert.match(result.warning, /503.*20 个并发/)
  assert.ok(!result.warning.includes('secret-should-not-be-echoed'))
})

test('后台锁定官方地址与自动元数据，拒绝伪造配置且失败不覆盖已有账号', async () => {
  const f = await storeFixture()
  let calls = 0
  const gateway = new Gateway(f.store, fetch, async (input, init) => {
    calls++
    if (String(input).endsWith('/usages'))
      return Response.json({
        usage: { limit: '100', used: '20', remaining: '80' },
        parallel: { limit: '3' }
      })
    assert.equal(String(input), 'https://api.kimi.com/coding/v1/models')
    const auth = new Headers(init?.headers).get('authorization')
    if (auth === 'Bearer invalid-key')
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    assert.equal(auth, 'Bearer secret-a')
    return Response.json({ data: [{ id: 'kimi-for-coding' }, { id: 'k3' }], max_concurrency: 3 })
  })
  try {
    await gateway.inspectAccount({ region: 'mainland-cn', secret: 'secret-a' })
    await gateway.saveAccount({
      ...accountInput('a'),
      baseUrl: 'https://untrusted.example/v1',
      maxConcurrency: 999,
      models: ['fake'],
      capabilities: { models: ['fake'], maxConcurrency: 999 }
    })
    assert.equal(calls, 2)
    const saved = f.store.get().accounts[0]
    assert.equal(saved.baseUrl, 'https://api.kimi.com/coding/v1')
    assert.equal(saved.maxConcurrency, 3)
    assert.deepEqual(saved.models, ['kimi-for-coding', 'k3'])
    await gateway.saveAccount({
      ...saved,
      maxConcurrency: 999,
      models: ['fake'],
      baseUrl: 'http://localhost:1234'
    })
    assert.equal(f.store.get().accounts[0].maxConcurrency, 3)
    await assert.rejects(gateway.saveAccount({ ...saved, secret: 'invalid-key' }), /API Key 无效/)
    assert.equal(f.store.get().accounts[0].credential.accessToken, 'secret-a')
    assert.equal(f.store.get().accounts[0].maxConcurrency, 3)
    const restored = new GatewayStore(f.file, f.secrets)
    await restored.load()
    assert.deepEqual(restored.get().accounts[0].capabilities, saved.capabilities)
  } finally {
    await f.cleanup()
  }
})

test('按参考项目请求头读取 parallel.limit 与额度，真实并发用于调度并可持久化', async () => {
  const f = await storeFixture()
  const request: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/models'))
      return Response.json({ data: [{ id: 'kimi-for-coding' }] })
    assert.equal(String(input), 'https://api.kimi.com/coding/v1/usages')
    assert.equal(new Headers(init?.headers).get('user-agent'), 'KimiCLI/1.6')
    return Response.json({
      parallel: { limit: '30' },
      usage: { limit: '100', used: '15.5', remaining: '84.5', resetTime: '2030-01-08T00:00:00Z' },
      limits: [
        {
          window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' },
          detail: { limit: '999', remaining: '900' }
        },
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { limit: '50', remaining: '40', resetTime: '2030-01-01T05:00:00Z' }
        }
      ],
      totalQuota: {}
    })
  }
  try {
    // 模拟上个版本一小时前以内的缓存，也必须补查额度和真实并发。
    const original = account('quota-account')
    await f.store.saveAccount({ ...accountInput('quota-account') }, original.capabilities!)
    const gateway = new Gateway(f.store, fetch, request)
    await gateway.refreshStaleAccounts()
    const saved = f.store.get().accounts[0]
    assert.equal(saved.maxConcurrency, 30)
    assert.equal(saved.capabilities?.warning, '')
    assert.deepEqual(saved.capabilities?.quota, {
      fiveHour: { limit: 50, used: 10, remaining: 40, resetAt: '2030-01-01T05:00:00.000Z' },
      weekly: { limit: 100, used: 15.5, remaining: 84.5, resetAt: '2030-01-08T00:00:00.000Z' },
      total: null,
      totalUnlimited: true
    })
    const scheduler = new Scheduler()
    const leases = Array.from({ length: 30 }, () =>
      scheduler.acquire([saved], group, 'kimi-for-coding', '', new Set())
    )
    assert.ok(leases.every(Boolean))
    assert.equal(scheduler.acquire([saved], group, 'kimi-for-coding', '', new Set()), undefined)
    leases.forEach((lease) => lease?.release())
    const reloaded = new GatewayStore(f.file, f.secrets)
    await reloaded.load()
    assert.deepEqual(reloaded.get().accounts[0].capabilities?.quota, saved.capabilities?.quota)
  } finally {
    await f.cleanup()
  }
})

test('额度解析保留零值、区分未知与无限制，支持总额度及重置时间', () => {
  assert.deepEqual(
    quotaWindow({ limit: '100', used: '100', remaining: '0', reset_time: 'invalid' }),
    { limit: 100, used: 100, remaining: 0, resetAt: null }
  )
  assert.equal(quotaWindow({ limit: 'invalid' }), null)
  assert.equal(parseKimiQuota({}), null)
  assert.equal(parseKimiQuota({ totalQuota: {} })?.totalUnlimited, true)
  const quota = parseKimiQuota({
    totalQuota: { limit: '1000', used: '100' },
    usage: { limit: 100, used: 0 },
    limits: [{ window: { duration: 5, time_unit: 'HOUR' }, detail: { limit: 50, used: 0 } }]
  })
  assert.equal(quota?.total?.remaining, 900)
  assert.equal(quota?.weekly?.remaining, 100)
  assert.equal(quota?.fiveHour?.remaining, 50)
  assert.equal(quota?.totalUnlimited, false)
  assert.equal(
    reportedConcurrency({ parallel: { limit: '0' }, usage: { limit: 100 } }, new Headers()),
    0
  )
})

test('并发缺失时默认 20，调度不超卖且优先采用上游值', () => {
  const capabilities = {
    models: ['kimi-for-coding'],
    maxConcurrency: null,
    checkedAt: Date.now(),
    warning: '上游未提供并发上限，暂按 1 个并发调度'
  }
  const fields = capabilityFields('mainland-cn', capabilities)
  assert.equal(fields.maxConcurrency, 20)
  assert.equal(fields.capabilities?.maxConcurrency, null)
  assert.match(fields.capabilities!.warning, /默认 20 个并发/)
  const candidate = { ...account('fallback'), ...fields }
  const scheduler = new Scheduler()
  const leases = Array.from({ length: 20 }, () =>
    scheduler.acquire([candidate], group, 'kimi-for-coding', '', new Set())
  )
  assert.ok(leases.every(Boolean))
  assert.equal(scheduler.acquire([candidate], group, 'kimi-for-coding', '', new Set()), undefined)
  leases.forEach((lease) => lease?.release())
  assert.equal(
    capabilityFields('mainland-cn', { ...capabilities, maxConcurrency: 30 }).maxConcurrency,
    30
  )
  assert.equal(
    capabilityFields('mainland-cn', { ...capabilities, maxConcurrency: 0 }).maxConcurrency,
    0
  )
})

test('手动并发上限持久化、控制槽位，刷新保留且可恢复自动', async () => {
  const f = await storeFixture()
  try {
    const id = await f.store.saveAccount(accountInput('manual'), {
      models: ['kimi-for-coding'],
      maxConcurrency: 30,
      checkedAt: Date.now(),
      warning: '',
      quota: null
    })
    await f.store.saveAccount({ ...f.store.get().accounts[0], concurrencyOverride: 4 })
    const gateway = new Gateway(f.store, fetch, async (input) =>
      String(input).endsWith('/models')
        ? Response.json({ data: [{ id: 'kimi-for-coding' }] })
        : Response.json({ parallel: { limit: 60 }, usage: { limit: 100, remaining: 80 } })
    )
    await gateway.refreshAccount(id)
    const saved = f.store.get().accounts[0]
    assert.equal(saved.maxConcurrency, 4)
    assert.equal(saved.concurrencyOverride, 4)
    assert.equal(saved.capabilities?.maxConcurrency, 60)
    const scheduler = new Scheduler()
    const leases = Array.from({ length: 4 }, () =>
      scheduler.acquire([saved], group, 'kimi-for-coding', '', new Set())
    )
    assert.ok(leases.every(Boolean))
    assert.equal(scheduler.acquire([saved], group, 'kimi-for-coding', '', new Set()), undefined)
    leases.forEach((lease) => lease?.release())
    const restored = new GatewayStore(f.file, f.secrets)
    await restored.load()
    assert.equal(restored.get().accounts[0].maxConcurrency, 4)
    await restored.saveAccount({ ...saved, name: 'renamed', concurrencyOverride: undefined })
    assert.equal(restored.get().accounts[0].concurrencyOverride, 4)
    for (const value of [0, -1, 1.5, 1001, NaN, '3']) {
      await assert.rejects(
        restored.saveAccount({ ...saved, concurrencyOverride: value }),
        /手动并发上限/
      )
    }
    await restored.saveAccount({ ...saved, concurrencyOverride: null })
    assert.equal(restored.get().accounts[0].maxConcurrency, 60)
    assert.equal(restored.get().accounts[0].concurrencyOverride, null)
  } finally {
    await f.cleanup()
  }
})
