import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeFixture, imageBase64 } from './session-migration-fixture'
import { convertZcode } from '../src/main/services/zcode-converter'
import { createHash } from 'node:crypto'
import { SessionMigration, workspaceKey } from '../src/main/services/session-migration'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'navo-migration-'))
  const paths = { source: join(root, 'source'), target: join(root, 'target') }
  await mkdir(join(paths.source, 'abc'), { recursive: true })
  const file = join(paths.source, 'abc/task.json')
  const raw = JSON.stringify(nativeFixture('/work/demo'))
  await writeFile(file, raw)
  return { root, paths, file, raw, service: new SessionMigration() }
}

test('迁移保留对话和源文件，注册索引且重复导入不覆盖继续后的会话', async () => {
  const f = await fixture()
  try {
    const scan = await f.service.scan(f.paths)
    assert.equal(scan.sessions.length, 1)
    const imported = await f.service.migrate(f.paths, scan.sessions)
    assert.equal(imported.imported, 1)
    assert.deepEqual(imported.errors, [])
    const indexFile = join(f.paths.target, 'session_index.jsonl')
    const index = await readFile(indexFile, 'utf8')
    const entry = JSON.parse(index)
    assert.equal(entry.workDir, '/work/demo')
    assert.equal(await readFile(join(entry.sessionDir, 'zcode-source.json'), 'utf8'), f.raw)
    assert.equal(await readFile(f.file, 'utf8'), f.raw)
    const state = JSON.parse(await readFile(join(entry.sessionDir, 'state.json'), 'utf8'))
    assert.equal(state.title, '测试迁移')
    assert.equal(state.agents.main.homedir, join(entry.sessionDir, 'agents/main'))
    const wireFile = join(entry.sessionDir, 'agents/main/wire.jsonl')
    const rows = (await readFile(wireFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const events = rows.filter((r) => r.type === 'context.append_loop_event').map((r) => r.event)
    assert.deepEqual(
      events.filter((e) => e.type === 'tool.call').map((e) => e.name),
      ['Bash', 'Edit', 'Agent', 'Bash']
    )
    assert.equal(
      events.find((e) => e.type === 'tool.result' && e.toolCallId === 'call_edit').result.isError,
      true
    )
    assert.deepEqual(
      rows.filter((r) => r.type === 'turn.ended').map((r) => [r.turnId, r.reason]),
      [
        [0, 'completed'],
        [1, 'cancelled']
      ]
    )
    const image = rows
      .find((r) => r.type === 'context.append_message')
      .message.content.find((p: { type: string }) => p.type === 'image_url')
    const mediaId = image.imageUrl.url.replace('kimi-file://', '')
    assert.deepEqual(
      await readFile(join(entry.sessionDir, 'media', mediaId + '.png')),
      Buffer.from(imageBase64, 'base64')
    )
    assert.equal(Object.keys(state.agents).length, 2)
    await writeFile(wireFile, 'continued')
    assert.deepEqual(await f.service.migrate(f.paths, scan.sessions), {
      imported: 0,
      skipped: 1,
      completedKeys: scan.sessions.map((session) => session.key),
      errors: [],
      warnings: []
    })
    assert.equal(await readFile(wireFile, 'utf8'), 'continued')
    assert.equal(await readFile(indexFile, 'utf8'), index)
    assert.equal((await f.service.scan(f.paths)).sessions[0].imported, true)
    assert.ok((await readdir(join(f.paths.target, 'sessions/.index-dirty'))).length)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('损坏文件隔离，源文件变化阻止导入，路径穿越和符号链接被拒绝', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.paths.source, 'abc/broken.json'), '{')
    await writeFile(
      join(f.paths.source, 'abc/empty.json'),
      JSON.stringify({ meta: { taskId: 'empty', workspacePath: '/work/demo' }, messages: [] })
    )
    const scan = await f.service.scan(f.paths)
    assert.equal(scan.sessions.length, 1)
    assert.equal(scan.errors.length, 1)
    await writeFile(f.file, f.raw + ' ')
    let result = await f.service.migrate(f.paths, scan.sessions)
    assert.match(result.errors[0], /已变化/)
    result = await f.service.migrate(f.paths, [{ key: '../outside.json', fingerprint: '' }])
    assert.match(result.errors[0], /无效/)
    await rm(f.file)
    await writeFile(join(f.root, 'outside.json'), f.raw)
    await symlink(join(f.root, 'outside.json'), f.file)
    result = await f.service.migrate(f.paths, scan.sessions)
    assert.match(result.errors[0], /符号链接/)
    assert.equal(result.imported, 0)
    assert.ok(!(await readdir(f.paths.target)).includes('.navo-zcode-migration.lock'))
    assert.throws(() => f.service.importRequest({ paths: f.paths, sessions: [null] }), /无效/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('中断后重试补全索引，锁防止并发迁移', async () => {
  const f = await fixture()
  try {
    const scan = await f.service.scan(f.paths)
    await f.service.migrate(f.paths, scan.sessions)
    await rm(join(f.paths.target, 'session_index.jsonl'))
    const retry = await f.service.migrate(f.paths, scan.sessions)
    assert.equal(retry.skipped, 1)
    assert.ok(
      JSON.parse(await readFile(join(f.paths.target, 'session_index.jsonl'), 'utf8')).sessionId
    )
    await writeFile(join(f.paths.target, '.navo-zcode-migration.lock'), 'test')
    await assert.rejects(f.service.migrate(f.paths, scan.sessions), /迁移正在进行/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Kimi 工作区键遵循已安装客户端规则', () => {
  assert.equal(workspaceKey('/Users/liujialin'), 'wd_liujialin_436edd2738a4')
  assert.equal(workspaceKey('/Work/My App/'), workspaceKey('/Work/My App'))
  assert.match(workspaceKey('/中文'), /^wd_workspace_[a-f0-9]{12}$/)
})

test('默认来源不存在时仍返回可编辑路径和明确错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'navo-missing-source-'))
  try {
    const paths = { source: join(root, 'missing'), target: join(root, 'target') }
    const scan = await new SessionMigration().scan(paths)
    assert.deepEqual(scan.paths, paths)
    assert.deepEqual(scan.sessions, [])
    assert.match(scan.errors[0], /无法读取 Zcode 会话目录/)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('旧版纯文本导入可重新迁移，旧会话及继续内容保持不变', async () => {
  const f = await fixture()
  try {
    const legacyId =
      'session_navo_zcode_' +
      createHash('sha256').update('/work/demo\0task').digest('hex').slice(0, 32)
    const legacyDir = join(f.paths.target, 'sessions', workspaceKey('/work/demo'), legacyId)
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'state.json'), 'continued old session')
    const scan = await f.service.scan(f.paths)
    assert.equal(scan.sessions[0].legacyImported, true)
    assert.equal(scan.sessions[0].imported, false)
    const result = await f.service.migrate(f.paths, scan.sessions)
    assert.equal(result.imported, 1)
    assert.equal(await readFile(join(legacyDir, 'state.json'), 'utf8'), 'continued old session')
    assert.notEqual(
      JSON.parse(await readFile(join(f.paths.target, 'session_index.jsonl'), 'utf8')).sessionId,
      legacyId
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('不认识或不完整的内容阻止迁移，不静默丢弃', () => {
  const fixture = nativeFixture('/work/demo')
  const convert = (value: unknown) =>
    convertZcode(JSON.stringify(value), '/target/session', 'session_test')
  const malformed = structuredClone(fixture) as any
  malformed.messages[1].parts[0] = { type: 'new-unknown-type', content: 'preserve me' }
  assert.throws(() => convert(malformed), /未知/)
  malformed.messages[1].parts = fixture.messages[1].parts
  malformed.messages[1].content = 'different text'
  assert.throws(() => convert(malformed), /不一致/)
  malformed.messages[1].content = fixture.messages[1].content
  malformed.messages[0].attachments[0].dataBase64 = 'invalid!'
  assert.throws(() => convert(malformed), /有效/)
})

test('前导 assistant、重复工具 ID、纯用户尾轮正确封闭', () => {
  const value = {
    meta: { taskId: 'x', workspacePath: '/work' },
    messages: [
      {
        role: 'assistant',
        content: 'orphan',
        tools: [
          {
            title: 'Bash',
            status: 'failed',
            input: {},
            output: 'error',
            raw: { toolCallId: 'same' }
          }
        ]
      },
      { role: 'user', content: 'next' },
      {
        role: 'assistant',
        content: 'reply',
        tools: [
          {
            title: 'Bash',
            status: 'completed',
            input: {},
            output: 'ok',
            raw: { toolCallId: 'same' }
          }
        ]
      },
      { role: 'user', content: 'unanswered' }
    ]
  }
  const result = convertZcode(JSON.stringify(value), '/target', 'session_x')
  const rows = result.wire
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const ids = rows.filter((r) => r.event?.type === 'tool.call').map((r) => r.event.toolCallId)
  assert.equal(new Set(ids).size, 2)
  assert.deepEqual(
    rows.filter((r) => r.type === 'turn.ended').map((r) => r.turnId),
    [0, 1, 2]
  )
  assert.equal(result.state.lastTurnReason, 'cancelled')
})

test('源会话新增内容后导入完整新快照，不覆盖已继续的 Kimi 会话', async () => {
  const f = await fixture()
  try {
    const scan = await f.service.scan(f.paths)
    await f.service.migrate(f.paths, scan.sessions)
    const first = JSON.parse(await readFile(join(f.paths.target, 'session_index.jsonl'), 'utf8'))
    const wire = join(first.sessionDir, 'agents/main/wire.jsonl')
    await writeFile(wire, 'continued in Kimi')
    const changed = JSON.parse(f.raw)
    changed.messages.push({ role: 'user', content: 'new source message', timestamp: 6000 })
    await writeFile(f.file, JSON.stringify(changed))
    const next = await f.service.scan(f.paths)
    assert.equal(next.sessions[0].imported, false)
    assert.equal((await f.service.migrate(f.paths, next.sessions)).imported, 1)
    const entries = (await readFile(join(f.paths.target, 'session_index.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(entries.length, 2)
    assert.equal(await readFile(wire, 'utf8'), 'continued in Kimi')
    assert.match(
      await readFile(join(entries[1].sessionDir, 'agents/main/wire.jsonl'), 'utf8'),
      /new source message/
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('合并 CLI 数据库和旧目录，按索引核对项目并保留子会话和 part 顺序', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const root = await mkdtemp(join(tmpdir(), 'navo-zcode-db-'))
  const source = join(root, '.zcode'),
    target = join(root, 'target')
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    await mkdir(join(source, 'cli/db'), { recursive: true })
    await mkdir(join(source, 'v2/sessions/abc'), { recursive: true })
    db = new DatabaseSync(join(source, 'cli/db/db.sqlite'))
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, revert TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, sequence INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, sequence INTEGER, data TEXT);
      CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, position INTEGER);`)
    for (const [id, parent, project] of [
      ['sess_root', null, 'cc-switch'],
      ['sess_child', 'sess_root', 'cc-switch'],
      ['sess_other', null, 'codedance-plugin-marketplace'],
      ['sess_empty', null, 'empty']
    ]) {
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, 1, 2, NULL, NULL)').run(
        id,
        parent,
        join(root, project!),
        id
      )
      if (id === 'sess_empty') continue
      db.prepare('INSERT INTO message VALUES (?, ?, 1, 1, 0, ?)').run(
        `${id}_u`,
        id,
        JSON.stringify({ role: 'user' })
      )
      db.prepare('INSERT INTO message VALUES (?, ?, 2, 2, 1, ?)').run(
        `${id}_a`,
        id,
        JSON.stringify({ role: 'assistant' })
      )
      const parts = [
        ['u', 0, { type: 'text', text: 'Question' }],
        ['a', 2, { type: 'text', text: 'After' }],
        ['a', 0, { type: 'reasoning', text: 'Think first' }],
        [
          'a',
          1,
          {
            type: 'tool',
            callID: `call_${id}`,
            tool: id === 'sess_root' ? 'Agent' : 'Read',
            state: {
              status: 'completed',
              input: id === 'sess_root' ? { prompt: 'Question' } : { file_path: '/example' },
              output: 'Read result'
            }
          }
        ]
      ] as const
      for (const [role, sequence, part] of parts)
        db.prepare('INSERT INTO part VALUES (?, ?, ?, 1, 1, ?, ?)').run(
          `${id}_${role}_${sequence}`,
          id,
          `${id}_${role}`,
          sequence,
          JSON.stringify(part)
        )
    }
    const index = new DatabaseSync(join(source, 'v2/tasks-index.sqlite'))
    index.exec(
      'CREATE TABLE tasks (task_id TEXT, workspace_path TEXT, title TEXT, archived INTEGER, deleted INTEGER, meta_json TEXT)'
    )
    for (const id of ['sess_root', 'sess_other', 'sess_empty'])
      index
        .prepare('INSERT INTO tasks VALUES (?, ?, ?, 0, 0, ?)')
        .run(
          id,
          join(
            root,
            id === 'sess_root'
              ? 'cc-switch'
              : id === 'sess_other'
                ? 'codedance-plugin-marketplace'
                : 'empty'
          ),
          `Title ${id}`,
          '{}'
        )
    index.close()
    const old = nativeFixture(join(root, 'legacy'))
    await writeFile(join(source, 'v2/sessions/abc/old.json'), JSON.stringify(old))
    const manager = new SessionMigration()
    const scan = await manager.scan({ source, target })
    assert.deepEqual(scan.errors, [])
    assert.equal(scan.sessions.length, 3)
    assert.equal(scan.coverage?.matched, 3)
    assert.deepEqual(scan.coverage?.sources, ['CLI 数据库', '旧版 JSON'])
    assert.ok(scan.sessions.some((s) => s.workspace === join(root, 'codedance-plugin-marketplace')))
    const native = scan.sessions.find((s) => s.key === 'sqlite:sess_root')!
    assert.equal(native.title, 'Title sess_root')
    assert.equal(native.counts.subagents, 1)
    assert.equal(native.counts.tools, 2)
    const legacyPathScan = await manager.scan({ source: join(source, 'v2/sessions'), target })
    assert.equal(legacyPathScan.sessions.length, scan.sessions.length)
    const migrated = await manager.migrate({ source, target }, [native])
    assert.equal(migrated.imported, 1)
    assert.deepEqual(migrated.errors, [])
    const entry = JSON.parse(await readFile(join(target, 'session_index.jsonl'), 'utf8'))
    const state = JSON.parse(await readFile(join(entry.sessionDir, 'state.json'), 'utf8'))
    const childId = Object.keys(state.agents).find((id) => id !== 'main')!
    assert.equal(state.agents[childId].parentAgentId, 'main')
    const snapshot = JSON.parse(await readFile(join(entry.sessionDir, 'zcode-source.json'), 'utf8'))
    assert.equal(snapshot.nativeSubagents[0].parentToolCallId, 'call_sess_root')
    assert.match(
      await readFile(join(entry.sessionDir, 'agents', childId, 'wire.jsonl'), 'utf8'),
      /Think first/
    )
    const wire = (await readFile(join(entry.sessionDir, 'agents/main/wire.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    assert.deepEqual(
      wire
        .filter((r) => ['content.part', 'tool.call'].includes(r.event?.type))
        .map((r) =>
          r.event.type === 'tool.call' ? r.event.name : r.event.part.think || r.event.part.text
        ),
      ['Think first', 'Agent', 'After']
    )
    db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'Changed' }),
      'sess_root_u_0'
    )
    const changed = await manager.migrate({ source, target }, [native])
    assert.match(changed.errors[0], /已变化/)
  } finally {
    db?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('数据库当前分支排除撤回消息，保留重新创建后的消息', async () => {
  const { activeBranch } = await import('../src/main/services/zcode-database')
  const messages = ['kept', 'old', 'old-reply', 'new', 'new-reply'].map((id) => ({ id }))
  assert.deepEqual(
    activeBranch(messages, {
      targetMessageID: 'old',
      keptMessageIDs: ['kept'],
      createdMessageID: 'new'
    }).map((m) => m.id),
    ['kept', 'new', 'new-reply']
  )
  assert.deepEqual(
    activeBranch(messages, {
      targetMessageID: 'old',
      keptMessageIDs: [],
      branchCutAfterMessageID: 'old-reply'
    }).map((m) => m.id),
    ['new', 'new-reply']
  )
})

test('数据库任务通知转换为原生 task origin，Agent 结果可定位独立子代理', async () => {
  const { parseTaskNotification } = await import('../src/main/services/zcode-database')
  const notice =
    '<task-notification><task-id>agent_child</task-id><tool-use-id>call_child</tool-use-id><status>completed</status><summary>Explore &quot;project&quot; completed.</summary><result>完整子代理结果</result></task-notification>'
  const parsed = parseTaskNotification(notice)!
  assert.equal(parsed.summary, 'Explore "project" completed.')
  assert.equal(parseTaskNotification('普通用户消息'), undefined)
  const source = {
    meta: { taskId: 'parent', workspacePath: '/project', sourceDatabase: true },
    messages: [
      { role: 'user', content: '检查项目' },
      {
        role: 'assistant',
        content: '',
        tools: [
          {
            name: 'Agent',
            title: 'Explore',
            status: 'completed',
            input: { prompt: '检查文件' },
            output: 'done',
            raw: { toolCallId: 'call_child' }
          }
        ]
      },
      { role: 'user', content: notice, sourceMessageId: 'notice1', taskNotification: parsed },
      { role: 'assistant', content: '收到子代理结果' }
    ],
    nativeSubagents: [
      {
        meta: {
          taskId: 'sess_subagent_agent_child',
          workspacePath: '/project',
          sourceDatabase: true
        },
        parentId: 'parent',
        parentToolCallIds: ['call_child'],
        parentToolCallId: 'call_child',
        messages: [
          { role: 'user', content: '检查文件' },
          { role: 'assistant', content: '完整子代理结果' }
        ]
      }
    ]
  }
  const result = convertZcode(JSON.stringify(source), '/target', 'session_case')
  const records = result.wire
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(records.filter((r) => r.type === 'turn.prompt').length, 1)
  const notification = records.find((r) => r.message?.origin?.kind === 'task')
  assert.ok(notification)
  assert.match(notification.message.content[0].text, /<notification type="task.completed"/)
  assert.doesNotMatch(notification.message.content[0].text, /<task-notification>/)
  assert.match(notification.message.content[0].text, /完整子代理结果/)
  const call = records.find((r) => r.event?.type === 'tool.result')
  assert.match(
    call.event.result.output[0].text,
    new RegExp(`agent_id: ${notification.message.origin.taskId}`)
  )
  assert.ok(result.files.has(`agents/${notification.message.origin.taskId}/wire.jsonl`))
  assert.ok(!result.warnings.some((warning) => warning.includes('缺少独立记录')))
})

test('后台线程扫描与迁移保持结果一致，报告进度并拒绝重叠任务，失败后可重试', async () => {
  const { SessionMigrationService } = await import('../src/main/services/session-migration-service')
  const f = await fixture()
  const service = new SessionMigrationService()
  const progress: import('../src/shared/session-migration').MigrationProgress[] = []
  try {
    const pending = service.run('scan', f.paths, (value) => progress.push(value))
    await assert.rejects(service.run('scan', f.paths), /正在进行/)
    const scan = await pending
    assert.deepEqual(scan, await f.service.scan(f.paths))
    assert.deepEqual(progress.at(-1), { phase: 'scan', completed: 1, total: 1 })
    const result = await service.run(
      'migrate',
      { paths: f.paths, sessions: scan.sessions },
      (value) => progress.push(value)
    )
    assert.equal(result.imported, 1)
    assert.deepEqual(
      result.completedKeys,
      scan.sessions.map((session) => session.key)
    )
    assert.deepEqual(progress.at(-1), { phase: 'migrate', completed: 1, total: 1 })
    assert.equal((await service.run('scan', f.paths)).sessions[0].imported, true)
    await assert.rejects(
      service.run('scan', { source: 'relative', target: 'relative' }),
      /绝对路径/
    )
    assert.equal((await service.run('scan', f.paths)).sessions.length, 1)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
