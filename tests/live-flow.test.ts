import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveFlowTracker } from '../src/main/services/live-flow'
import { HARNESSES, harnessName, identifyHarness, flowDirections } from '../src/shared/live-flow'

test('UA recognizes client families independently of version', () => {
  for (const [ua, expected] of [
    ['Key/1.0', 'Key'],
    ['Zcode/2.0', 'Zcode'],
    ['KimiCLI/1.6', 'Kimi Code'],
    ['codex/0.1', 'Codex'],
    ['claude-cli/1.0', 'Claude Code'],
    ['opencode/1', 'OpenCode'],
    ['python-httpx/1', '未知客户端']
  ])
    assert.equal(harnessName(ua), expected)
})

test('sticky session reuses a display lane for sequential calls across models; clients stay separate', () => {
  const tracker = new LiveFlowTracker()
  const first = tracker.start({ 'user-agent': 'Key/1' }, 'sticky-cache-key', 'model-a')
  tracker.finish(first, true, null)
  tracker.start({ 'user-agent': 'Key/2' }, 'sticky-cache-key', 'model-b')
  tracker.start({ 'user-agent': 'Key/1' }, 'other-session', 'model-a')
  tracker.start({ 'user-agent': 'Zcode/1' }, 'sticky-cache-key', 'model-a')
  const [a, b, c, d] = tracker.snapshot()
  assert.equal(a.agentKey, b.agentKey)
  assert.notEqual(a.agentKey, c.agentKey)
  assert.notEqual(a.agentKey, d.agentKey)
  assert.equal(a.identity, 'session')
  assert.ok(!JSON.stringify(tracker.snapshot()).includes('sticky-cache-key'))
})

test('requests without sticky identity stay explicitly temporary', () => {
  const tracker = new LiveFlowTracker()
  tracker.start({}, '', 'model')
  tracker.start({}, '', 'model')
  const [a, b] = tracker.snapshot()
  assert.equal(a.identity, 'request')
  assert.notEqual(a.agentKey, b.agentKey)
})

test('live activity, usage, interruption and expiry preserve long running requests', () => {
  let now = 1000
  const tracker = new LiveFlowTracker(() => now)
  const a = tracker.start({}, 'a', 'm')
  const b = tracker.start({}, 'b', 'm')
  tracker.activity(a, 10)
  const usage = { input: 100, output: 3, cacheRead: null, cacheWrite: null, cost: null }
  tracker.update(a, { usage })
  assert.equal(tracker.snapshot()[0].state, 'streaming')
  assert.equal(tracker.snapshot()[0].bytes, 10)
  const copy = tracker.snapshot()
  copy[0].usage!.output = 999
  assert.equal(tracker.snapshot()[0].usage!.output, 3)
  tracker.finish(a, false, usage)
  assert.equal(tracker.snapshot()[0].state, 'error')
  now += 300000
  assert.deepEqual(
    tracker.snapshot().map((f) => f.id),
    [b]
  )
})

test('ended telemetry is bounded without evicting live requests', () => {
  const tracker = new LiveFlowTracker()
  const live = tracker.start({}, 'live', 'm')
  for (let i = 0; i < 205; i++) tracker.finish(tracker.start({}, 'same-session', 'm'), true, null)
  assert.equal(tracker.snapshot().length, 201)
  assert.ok(tracker.snapshot().some((f) => f.id === live))
})

test('recognizes all required harnesses and real UA product variants', () => {
  const cases: [string, string][] = [
    ['ZCode/3.5.3', 'Zcode'],
    ['KimiCLI/1.37.0', 'Kimi Code'],
    ['Kimi Code/1.0', 'Kimi Code'],
    ['claude-cli/2.1.0 (external, cli)', 'Claude Code'],
    ['Claude/1.0', 'Claude Code'],
    ['Claude Code/1.0', 'Claude Code'],
    ['codex_cli_rs/0.1.0 (Mac OS; arm64)', 'Codex'],
    ['codex_vscode/1.0', 'Codex'],
    ['codex-tui/0.1', 'Codex'],
    ['Qoder-Cli', 'Qoder'],
    ['qodercli/1.1.54', 'Qoder'],
    ['Qoder/0.16.0', 'Qoder'],
    ['CLI/2.140.0 WorkBuddy/5.3.8', 'WorkBuddy'],
    ['WorkBuddy/5.3.8', 'WorkBuddy'],
    ['pi (darwin 25.0.0; arm64)', 'Pi'],
    ['pi (browser)', 'Pi'],
    ['pi-coding-agent', 'Pi'],
    ['pi.dev/0.70.0', 'Pi'],
    [
      'deepseek-harness/0.1.0 (+https://github.com/deepseek-ai/deepseek-harness)',
      'DeepSeek Harness'
    ],
    ['DeepSeek Harness/0.1', 'DeepSeek Harness'],
    ['Cline/3.51.0', 'Cline'],
    ['OpenAI/JS 6.15.0 Cline/3.51.0', 'Cline']
  ]
  for (const [ua, name] of cases) assert.equal(harnessName(ua), name, ua)
})

test('generic SDKs, models, comments and substring collisions do not invent harnesses', () => {
  for (const ua of [
    'OpenAI/JS 6.15.0',
    'Anthropic/JS 0.24.3',
    'Rs/JS 4.83.0',
    'node',
    'python-httpx/0.28.1',
    'DeepSeek/1.0',
    'deepseek-v4',
    'CodeBuddy/2.0',
    'raspberry-pi/1',
    'piXdev/1',
    'my-cline-proxy/1',
    'not-zcode/1',
    'Mozilla/5.0 (compatible; Cline/1.0)',
    'SDK/1 (+https://pi.dev; (Codex/1))',
    'SDK/pi',
    'x'.repeat(4097),
    'Cline/1\r\nInjected: yes'
  ])
    assert.equal(harnessName(ua), '未知客户端', ua.slice(0, 100))
})

test('explicit attribution supports every client even with a generic or overridden UA', () => {
  for (const h of HARNESSES) {
    assert.equal(identifyHarness({ 'user-agent': 'node' }, h.id), h.name)
    assert.equal(identifyHarness({ 'user-agent': 'node', 'x-navo-harness': h.id }), h.name)
    assert.equal(identifyHarness({ 'user-agent': 'node', 'x-kimi-helper-harness': h.id }), h.name)
  }
  assert.equal(
    identifyHarness({ 'x-navo-harness': 'cline', 'x-kimi-helper-harness': 'pi' }),
    'Cline'
  )
  assert.equal(identifyHarness({ 'user-agent': 'opencode/1', 'x-opencode-client': 'pi' }), 'Pi')
  assert.equal(
    identifyHarness({ 'user-agent': 'OpenAI/JS 1', 'x-client-type': 'cline-sdk' }),
    'Cline'
  )
  assert.equal(identifyHarness({ 'user-agent': 'OpenAI/JS 1', originator: 'cline' }), 'Cline')
  assert.equal(
    identifyHarness({ 'user-agent': 'Codex/1', 'x-kimi-helper-harness': 'cline' }, 'pi'),
    'Pi'
  )
  assert.equal(
    identifyHarness({ 'user-agent': ['cline'], 'x-kimi-helper-harness': ['pi'] }),
    '未知客户端'
  )
  assert.equal(
    identifyHarness({ 'user-agent': 'Codex/1', 'x-kimi-helper-harness': 'invalid' }),
    'Codex'
  )
  assert.equal(identifyHarness({ 'user-agent': 'node', originator: 'codex_cli_rs' }), 'Codex')
  const tracker = new LiveFlowTracker()
  tracker.start({ 'user-agent': 'node' }, 'shared', 'model', 'workbuddy')
  tracker.start({ 'user-agent': 'node' }, 'shared', 'model', 'qoder')
  assert.notEqual(tracker.snapshot()[0].agentKey, tracker.snapshot()[1].agentKey)
})

test('upload and download have independent event timestamps and byte counters', () => {
  let now = 1000
  const tracker = new LiveFlowTracker(() => now)
  const id = tracker.start({}, 'session', 'model')
  tracker.upload(id, 123)
  assert.deepEqual(flowDirections(tracker.snapshot(), now, true), { upload: true, download: false })
  now += 3000
  assert.deepEqual(flowDirections(tracker.snapshot(), now, true), {
    upload: false,
    download: false
  })
  tracker.activity(id, 50)
  assert.deepEqual(flowDirections(tracker.snapshot(), now, true), { upload: false, download: true })
  tracker.upload(id, 123)
  assert.deepEqual(flowDirections(tracker.snapshot(), now, true), { upload: true, download: true })
  const flow = tracker.snapshot()[0]
  assert.equal(flow.uploadBytes, 246)
  assert.equal(flow.bytes, 50)
  assert.deepEqual(flowDirections([flow], now, false), { upload: false, download: false })
  tracker.finish(id, true, null)
  tracker.upload(id, 100)
  assert.equal(tracker.snapshot()[0].uploadBytes, 246)
  assert.deepEqual(flowDirections(tracker.snapshot(), now, true), { upload: true, download: true })
  now += 2500
  assert.deepEqual(flowDirections(tracker.snapshot(), now, true), {
    upload: false,
    download: false
  })
})

test('failed and future-dated events never animate', () => {
  const tracker = new LiveFlowTracker(() => 1000)
  const id = tracker.start({}, '', 'm')
  tracker.upload(id, 12)
  tracker.activity(id, 23)
  assert.deepEqual(flowDirections(tracker.snapshot(), 900, true), {
    upload: false,
    download: false
  })
  tracker.finish(id, false, null)
  assert.deepEqual(flowDirections(tracker.snapshot(), 1000, true), {
    upload: false,
    download: false
  })
})

test('Kimi Code TypeScript CLI and web host are identified independently of the called model', () => {
  // Local kimi-code/apps/kimi-code/src/constant/app.ts: CLI_USER_AGENT_PRODUCT.
  for (const ua of [
    'kimi-code-cli/1.0.0',
    'kimi-code-cli/1.0.0 (web)',
    'KIMI-CODE-CLI/2.0.0-beta.1'
  ]) {
    assert.equal(harnessName(ua), 'Kimi Code')
    const tracker = new LiveFlowTracker()
    tracker.start({ 'user-agent': ua }, 'kimi-session', 'deepseek-flash')
    assert.equal(tracker.snapshot()[0].harness, 'Kimi Code')
  }
  assert.equal(harnessName('proxy-kimi-code-cli/1.0'), '未知客户端')
  assert.equal(harnessName('OpenAI/JS 1 (kimi-code-cli/1.0)'), '未知客户端')
})

test('Kimi desktop, CLI and VS Code share product attribution with native platform fallback', () => {
  const platforms = ['cli', 'desktop', 'vscode']
  for (const platform of platforms) {
    for (const suffix of ['', ' (web)', ' (macOS; arm64)']) {
      const ua = `kimi-code-${platform}/0.0.13${suffix}`
      assert.equal(harnessName(ua), 'Kimi Code')
      assert.equal(identifyHarness({ 'user-agent': ua }), 'Kimi Code')
    }
    const headers = { 'user-agent': 'OpenAI/JS 6.0', 'x-msh-platform': `kimi_code_${platform}` }
    assert.equal(identifyHarness(headers), 'Kimi Code')
    assert.equal(identifyHarness(headers, 'cline'), 'Cline')
    assert.equal(identifyHarness({ ...headers, 'x-kimi-helper-harness': 'pi' }), 'Pi')
  }
  for (const platform of [
    'kimi_code_',
    'kimi_code_desktop_proxy',
    'moonshot',
    'kimi_code_desktop\r\nx: y'
  ])
    assert.equal(
      identifyHarness({ 'user-agent': 'OpenAI/JS 6.0', 'x-msh-platform': platform }),
      '未知客户端'
    )
  assert.equal(identifyHarness({ 'x-msh-platform': ['kimi_code_desktop'] }), '未知客户端')
  assert.equal(harnessName('not-kimi-code-desktop/1'), '未知客户端')
})

test('five concurrent calls in one session share a display node across models and completions', () => {
  const tracker = new LiveFlowTracker()
  const ids = Array.from({ length: 5 }, (_, i) =>
    tracker.start(
      { 'user-agent': 'kimi-code-desktop/1', 'x-agent-id': `child-${i}` },
      'same-session',
      i % 2 ? 'other-model' : 'deepseek-v4.1-flash'
    )
  )
  const flows = tracker.snapshot()
  assert.equal(new Set(flows.map((f) => f.agentKey)).size, 1)
  assert.ok(flows.every((f) => f.identity === 'session'))
  tracker.finish(ids[2], true, null)
  const next = tracker.start({ 'user-agent': 'kimi-code-desktop/1' }, 'same-session', 'third-model')
  assert.equal(tracker.snapshot().find((f) => f.id === next)!.agentKey, flows[0].agentKey)
  assert.equal(tracker.snapshot().filter((f) => f.endedAt === null).length, 5)
})

test('agent IDs do not split a session or merge distinct sessions', () => {
  const tracker = new LiveFlowTracker()
  tracker.start({ 'x-agent-id': 'worker-a' }, 's', 'm')
  tracker.start({ 'x-agent-id': 'worker-b' }, 's', 'other-model')
  tracker.start({ 'x-subagent-id': 'worker-b' }, 'other-session', 'm')
  const [a, b, c] = tracker.snapshot()
  assert.equal(a.identity, 'session')
  assert.equal(a.agentKey, b.agentKey)
  assert.notEqual(a.agentKey, c.agentKey)
  assert.ok(!JSON.stringify(tracker.snapshot()).includes('worker-'))
})

test('idle nodes remain five minutes after the final concurrent request, and resume resets the timer', () => {
  let now = 1000
  const tracker = new LiveFlowTracker(() => now)
  const first = tracker.start({}, 's', 'm')
  const second = tracker.start({}, 's', 'm')
  const key = tracker.snapshot()[0].agentKey
  tracker.finish(first, true, null)
  now += 300001
  assert.equal(tracker.snapshot().filter((f) => f.endedAt === null).length, 1)
  tracker.finish(second, false, null)
  now += 299999
  assert.ok(tracker.snapshot().some((f) => f.agentKey === key))
  const resumed = tracker.start({}, 's', 'm')
  assert.equal(tracker.snapshot().find((f) => f.id === resumed)!.agentKey, key)
  now += 400000
  assert.ok(tracker.snapshot().some((f) => f.id === resumed))
  tracker.finish(resumed, true, null)
  now += 299999
  assert.ok(tracker.snapshot().some((f) => f.agentKey === key))
  now += 1
  assert.equal(tracker.snapshot().length, 0)
})

test('detail cap preserves the last idle record for each node for five minutes', () => {
  let now = 1000
  const tracker = new LiveFlowTracker(() => now)
  for (let i = 0; i < 205; i++) tracker.finish(tracker.start({}, `session-${i}`, 'm'), true, null)
  assert.equal(new Set(tracker.snapshot().map((f) => f.agentKey)).size, 205)
  now += 300000
  assert.equal(tracker.snapshot().length, 0)
})

test('all configured idle durations expire at the selected boundary', () => {
  for (const minutes of [5, 10, 15, 30, 60]) {
    let now = 1000
    const tracker = new LiveFlowTracker(
      () => now,
      () => minutes * 60000
    )
    tracker.finish(tracker.start({}, 'session', 'model'), true, null)
    now += minutes * 60000 - 1
    assert.equal(tracker.snapshot().length, 1)
    now++
    assert.equal(tracker.snapshot().length, 0)
  }
})

test('changing retention applies to existing idle nodes without resetting their clock', () => {
  let now = 1000
  let minutes = 5
  const tracker = new LiveFlowTracker(
    () => now,
    () => minutes * 60000
  )
  tracker.finish(tracker.start({}, 'session', 'model'), true, null)
  minutes = 60
  now += 10 * 60000
  assert.equal(tracker.snapshot().length, 1)
  minutes = 5
  assert.equal(tracker.snapshot().length, 0)
})
