import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { SessionMigration } = require('../artifacts/tests/src/main/services/session-migration.js')
const {
  nativeFixture,
  imageBase64
} = require('../artifacts/tests/tests/session-migration-fixture.js')
const binary = process.env.KIMI_CODE_BIN || join(homedir(), '.kimi-code/bin/kimi')
const root = await mkdtemp(join(tmpdir(), 'navo-kimi-contract-'))
let child
const requests = []
const mock = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push(body)
  assert.ok(req.url.endsWith('/chat/completions'), `Unexpected model API: ${req.url}`)
  const base = { id: 'mock-migration', object: 'chat.completion.chunk', created: 1, model: 'stub' }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(
    [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Continued successfully.' },
            finish_reason: null
          }
        ]
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }
      }
    ]
      .map((v) => `data: ${JSON.stringify(v)}\n\n`)
      .join('') + 'data: [DONE]\n\n'
  )
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const paths = { source: join(root, 'source'), target: join(root, 'target') }
  await mkdir(join(paths.source, 'abc'), { recursive: true })
  await writeFile(join(paths.source, 'abc/task.json'), JSON.stringify(nativeFixture(root)))
  const service = new SessionMigration()
  const scan = await service.scan(paths)
  const result = await service.migrate(paths, scan.sessions)
  assert.equal(result.imported, 1, JSON.stringify(result))
  const entry = JSON.parse(await readFile(join(paths.target, 'session_index.jsonl'), 'utf8'))
  let auditSessions = []
  if (process.env.NAVO_ZCODE_DATABASE_SESSION) {
    const {
      ZcodeDatabase,
      readTaskIndex
    } = require('../artifacts/tests/src/main/services/zcode-database.js')
    const sourceRoot = process.env.NAVO_ZCODE_AUDIT_SOURCE || join(homedir(), '.zcode')
    const db = new ZcodeDatabase(
      sourceRoot,
      join(sourceRoot, 'cli/db/db.sqlite'),
      await readTaskIndex(join(sourceRoot, 'v2/tasks-index.sqlite'))
    )
    const caseSource = join(root, 'case-source')
    try {
      await mkdir(join(caseSource, 'abc'), { recursive: true })
      await writeFile(
        join(caseSource, 'abc/case.json'),
        await db.read(process.env.NAVO_ZCODE_DATABASE_SESSION)
      )
    } finally {
      db.close()
    }
    const cases = await service.scan({ source: caseSource, target: paths.target })
    assert.deepEqual(cases.errors, [])
    const imported = await service.migrate(
      { source: caseSource, target: paths.target },
      cases.sessions
    )
    assert.deepEqual(imported.errors, [])
    auditSessions = (await readFile(join(paths.target, 'session_index.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((item) => item.sessionId !== entry.sessionId)
  }

  if (process.env.NAVO_ZCODE_AUDIT_SOURCE && !process.env.NAVO_ZCODE_DATABASE_SESSION) {
    const auditPaths = { source: process.env.NAVO_ZCODE_AUDIT_SOURCE, target: paths.target }
    const audit = await service.scan(auditPaths)
    assert.deepEqual(audit.errors, [], 'Audit source has unsupported or corrupt sessions')
    const imported = await service.migrate(auditPaths, audit.sessions)
    assert.deepEqual(imported.errors, [])
    auditSessions = (await readFile(join(paths.target, 'session_index.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((e) => e.sessionId !== entry.sessionId)
  }

  await writeFile(
    join(paths.target, 'config.toml'),
    `default_model = "stub"\n[providers.stub]\ntype = "openai"\nbase_url = "http://127.0.0.1:${mock.address().port}"\napi_key = "stub"\n[models.stub]\nprovider = "stub"\nmodel = "stub"\nmax_context_size = 100000\n`
  )
  const reserve = createServer()
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r))
  const port = reserve.address().port
  await new Promise((r) => reserve.close(r))
  child = spawn(binary, ['web', '--no-open', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, KIMI_CODE_HOME: paths.target },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.resume()
  child.stderr.resume()
  let token
  const url = `http://127.0.0.1:${port}/api/v1`
  const request = async (path, body) => {
    const response = await fetch(url + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    })
    const envelope = await response.json()
    assert.equal(envelope.code, 0, `${path}: ${JSON.stringify(envelope)}`)
    return envelope.data
  }
  let cold
  const transcriptPath = `/sessions/${entry.sessionId}/transcript?agent_id=main`
  for (let i = 0; i < 100; i++) {
    try {
      token = (await readFile(join(paths.target, 'server.token'), 'utf8')).trim()
      cold = await request(transcriptPath)
      break
    } catch (e) {
      if (i === 99 || child.exitCode !== null) throw e
    }
    await wait(100)
  }
  const turns = (snapshot) => snapshot.items.filter((i) => i.kind === 'turn')
  const frames = (snapshot) => turns(snapshot).flatMap((t) => t.steps.flatMap((s) => s.frames))
  const tools = frames(cold).filter((f) => f.kind === 'tool')
  assert.deepEqual(
    tools.map((t) => [t.name, t.state]),
    [
      ['Bash', 'done'],
      ['Edit', 'error'],
      ['Agent', 'done'],
      ['Bash', 'error']
    ]
  )
  assert.match(tools[0].output, /hello/)
  assert.equal(tools[0].input.command, 'echo hello')
  assert.equal(tools[1].input.old_string, 'old')
  assert.deepEqual(
    frames(cold)
      .filter((f) => f.kind === 'text' || f.kind === 'thinking')
      .map((f) => f.text),
    ['先分析问题。', '先检查。', '检查完成。', '已中断']
  )
  assert.deepEqual(
    turns(cold).map((t) => [t.turnId, t.state]),
    [
      ['t0', 'completed'],
      ['t1', 'cancelled']
    ]
  )
  assert.equal(cold.attachments.length, 1)
  if (process.env.NAVO_KIMI_UI_TEST === '1') {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
      await page.goto(`http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`)
      await page.getByText('测试迁移', { exact: true }).first().waitFor({ timeout: 15000 })
      const wizard = page.getByRole('dialog', { name: 'Welcome to Kimi Code' })
      if (await wizard.count())
        await wizard.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.getByText('测试迁移', { exact: true }).first().click({ timeout: 15000 })
      await page.getByText('检查完成。', { exact: true }).waitFor({ timeout: 15000 })
      assert.equal(await page.getByText('从 Zcode 导入的工具调用历史', { exact: false }).count(), 0)
      await page.getByText(/Ran 1 command/).click()
      await page.getByText('Thinking', { exact: true }).click()
      await page.getByText('先分析问题。', { exact: true }).waitFor()
      await mkdir('artifacts', { recursive: true })
      await page.screenshot({ path: 'artifacts/kimi-native-migration.png', fullPage: true })
      console.log('Kimi bundled frontend opened and rendered the imported session.')
      if (process.env.NAVO_ZCODE_DATABASE_SESSION && auditSessions.length) {
        const state = JSON.parse(
          await readFile(join(auditSessions[0].sessionDir, 'state.json'), 'utf8')
        )
        await page.getByText(state.title, { exact: true }).first().click()
        await page.getByText('在分析一下', { exact: true }).first().waitFor({ state: 'attached' })
        await page.locator('.chat-scroll').evaluate((el) => {
          el.scrollTop = 0
        })
        await page.getByText('3 tool calls', { exact: true }).first().waitFor()
        const childButton = page
          .getByRole('button')
          .filter({ hasText: '分析后端与核心服务架构' })
          .first()
        await page.getByText('3 tool calls', { exact: true }).first().click()
        await childButton.waitFor({ timeout: 15000 })
        assert.equal(await page.getByText('<task-notification>', { exact: false }).count(), 0)
        await page.screenshot({ path: 'artifacts/kimi-subagent-notifications.png', fullPage: true })
        console.log('Case frontend: no raw task-notification bubbles.')
        const childResponse = page
          .waitForResponse(
            (response) =>
              response.url().includes('/transcript?') &&
              response.url().includes('agent_id=agent_db_'),
            { timeout: 10000 }
          )
          .catch((error) => error)
        await childButton.click({ timeout: 10000 })
        const response = await childResponse
        if (response instanceof Error) throw response
        const childEnvelope = await response.json()
        assert.equal(childEnvelope.code, 0)
        assert.ok(
          childEnvelope.data.items.some(
            (item) =>
              item.kind === 'turn' &&
              item.steps.some((step) => step.frames.some((frame) => frame.kind === 'tool'))
          )
        )
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        )
        await page.screenshot({ path: 'artifacts/kimi-subagent-detail.png', fullPage: true })
        console.log('Case frontend: Agent card opened the independent subagent transcript.')
      }
    } finally {
      await browser.close()
    }
  }

  const fileId = cold.attachments[0].source.fileId
  const image = await fetch(`${url}/sessions/${entry.sessionId}/media/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  assert.equal(image.status, 200)
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(imageBase64, 'base64'))
  const sub = cold.agents.find((a) => a.type === 'sub')
  assert.ok(sub)
  const childTranscript = await request(
    `/sessions/${entry.sessionId}/transcript?agent_id=${sub.agentId}`
  )
  assert.deepEqual(
    frames(childTranscript)
      .filter((f) => f.kind === 'tool')
      .map((f) => f.name),
    ['Read']
  )
  assert.ok(cold.tasks.some((t) => t.agentId === sub.agentId))

  let auditedTools = 0,
    auditedThinking = 0
  for (const session of auditSessions) {
    const state = JSON.parse(await readFile(join(session.sessionDir, 'state.json'), 'utf8'))
    let toolCount = 0,
      thinkingCount = 0
    for (const agentId of Object.keys(state.agents)) {
      let before = ''
      while (true) {
        const page = await request(
          `/sessions/${session.sessionId}/transcript?agent_id=${agentId}&page_size=100${before ? `&before_turn=${before}` : ''}`
        )
        toolCount += frames(page).filter((f) => f.kind === 'tool').length
        thinkingCount += frames(page).filter((f) => f.kind === 'thinking').length
        if (!page.has_more) break
        const oldest = turns(page)[0]?.turnId
        assert.ok(oldest && oldest !== before, 'Pagination did not advance')
        before = oldest
      }
    }
    assert.equal(
      toolCount,
      state.custom.navoMigration.counts.tools,
      'Cold transcript dropped tool calls'
    )
    assert.equal(
      thinkingCount,
      state.custom.navoMigration.counts.thinking,
      'Cold transcript dropped thinking blocks'
    )
    auditedTools += toolCount
    auditedThinking += thinkingCount
  }
  if (auditSessions.length)
    console.log(
      `Real-source read-only audit: ${auditSessions.length} sessions, ${auditedTools} tool frames, ${auditedThinking} thinking frames verified through Kimi.`
    )
  await request(`/sessions/${entry.sessionId}/prompts`, {
    content: [{ type: 'text', text: 'Continue after migration.' }],
    model: 'stub',
    permission_mode: 'manual'
  })
  let live
  for (let i = 0; i < 100; i++) {
    live = await request(transcriptPath)
    if (
      frames(live).some((f) => f.kind === 'text' && f.text.includes('Continued successfully.')) &&
      turns(live).at(-1).state === 'completed'
    )
      break
    if (i === 99) throw new Error('Resume did not complete: ' + JSON.stringify(live))
    await wait(100)
  }
  assert.deepEqual(
    turns(live).map((t) => t.turnId),
    ['t0', 't1', 't2']
  )
  assert.equal(
    requests.length,
    1,
    'Only the new prompt should call the model; imported tools must never execute'
  )
  const history = requests[0].messages
  assert.ok(
    history.some(
      (m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.function.name === 'Bash')
    )
  )
  assert.ok(history.some((m) => m.role === 'tool' && JSON.stringify(m.content).includes('hello')))
  console.log(
    'Kimi native contract passed: cold transcript, thinking/tool frames, failures, media bytes, subagent linkage, resumed model context and next-turn IDs.'
  )
} catch (e) {
  // Server startup output may contain its ephemeral token. Never print it.
  throw new Error(`Kimi migration compatibility failed: ${e.message}`, { cause: e })
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(killTimer)
  }
  await new Promise((r) => mock.close(r))
  await rm(root, { recursive: true, force: true })
}
