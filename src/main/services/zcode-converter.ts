import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, join } from 'node:path'

export const MIGRATION_VERSION = 2
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const text = (v: unknown) => (typeof v === 'string' ? v : '')
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const time = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15 ? v : 0
const json = (v: unknown) => JSON.stringify(v) ?? ''
type Data = Record<string, unknown>
type Part =
  | { type: 'text'; text: string }
  | { type: 'think'; think: string }
  | { type: 'image_url'; imageUrl: { url: string; name?: string } }
  | { type: 'video_url'; videoUrl: { url: string; name?: string } }
  | { type: 'audio_url'; audioUrl: { url: string } }
type Outcome = 'completed' | 'cancelled' | 'failed'
export interface ConvertedSession {
  state: Data
  wire: string
  files: Map<string, Buffer | string>
  warnings: string[]
  counts: {
    messages: number
    tools: number
    thinking: number
    attachments: number
    subagents: number
  }
}

export class EmptyZcodeSessionError extends Error {
  constructor() {
    super('会话没有消息')
    this.name = 'EmptyZcodeSessionError'
  }
}

export function parseZcode(raw: string) {
  return parseSourceObject(object(JSON.parse(raw)))
}

function parseSourceObject(data: Data) {
  const meta = object(data.meta)
  if (!text(meta.taskId) || !isAbsolute(text(meta.workspacePath)) || !Array.isArray(data.messages))
    throw new Error('不是受支持的 Zcode v2 会话')
  const messages = data.messages.map((v: unknown) => {
    const m = object(v)
    if (!['user', 'assistant'].includes(text(m.role)) || typeof m.content !== 'string')
      throw new Error('包含不支持的消息格式')
    for (const key of ['parts', 'tools', 'attachments'])
      if (m[key] !== undefined && !Array.isArray(m[key])) throw new Error(`消息 ${key} 格式无效`)
    return m
  })
  if (!messages.length) throw new EmptyZcodeSessionError()
  return { meta, messages }
}

function toolName(tool: Data) {
  const raw = object(tool.raw),
    meta = object(object(raw._meta).claudeCode)
  const explicit = text(meta.toolName) || text(raw.name) || text(tool.name)
  if (explicit) return explicit
  const title = text(tool.title)
  if (/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(title)) return title
  // ACP may expose only a human title and kind, so preserve that label rather than inventing an API name.
  return `ZcodeTool_${text(tool.kind).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'}`
}
function toolParent(tool: Data) {
  return text(object(object(object(tool.raw)._meta).claudeCode).parentToolUseId)
}
function toolId(tool: Data) {
  return text(object(tool.raw).toolCallId) || text(tool.toolCallId)
}
function toolDisplay(tool: Data, name: string): Data {
  const input = object(tool.input),
    path = text(input.file_path) || text(input.path)
  if (typeof input.command === 'string')
    return {
      kind: 'command',
      command: input.command,
      description: text(input.description),
      language: 'bash'
    }
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string' && path)
    return { kind: 'diff', path, before: input.old_string, after: input.new_string }
  if (path && (name === 'Write' || name === 'Read' || tool.kind === 'read' || tool.kind === 'edit'))
    return {
      kind: 'file_io',
      operation: name === 'Write' ? 'write' : tool.kind === 'edit' ? 'edit' : 'read',
      path,
      content: input.content
    }
  if (name === 'Agent' || name === 'Task')
    return {
      kind: 'agent_call',
      agent_name: text(input.subagent_type) || 'agent',
      prompt: text(input.prompt),
      background: input.run_in_background === true
    }
  if (name === 'Skill')
    return { kind: 'skill_call', skill_name: text(input.skill), args: text(input.args) }
  if (typeof input.url === 'string') return { kind: 'url_fetch', url: input.url }
  if (typeof input.pattern === 'string' || typeof input.query === 'string')
    return { kind: 'search', query: text(input.query) || text(input.pattern), scope: path }
  return { kind: 'generic', summary: text(tool.title) || name, detail: tool.input }
}

// Matches Kimi's v1.5 loopEventFold, sessionMediaStore and transcript grouping contracts.
// Keep this adapter independent of the user's Kimi checkout; cross-project tests exercise the real reader.
export function convertZcode(
  raw: string,
  sessionDir: string,
  id: string,
  mainAgentId = 'main'
): ConvertedSession {
  const source = object(JSON.parse(raw))
  const { meta, messages } = parseSourceObject(source)
  // Links need identity only: copying every sibling transcript into every child is quadratic.
  const nativeRoster = list(source.nativeSubagents ?? source.nativeAgentLinks).map((value) => {
    const child = object(value)
    return {
      meta: { taskId: object(child.meta).taskId },
      parentId: child.parentId,
      parentToolCallId: child.parentToolCallId,
      parentToolCallIds: child.parentToolCallIds
    }
  })
  const nativeAgentId = (sourceId: string) => `agent_db_${digest(sourceId).slice(0, 24)}`
  const nativeBindings = new Map<string, Data>()
  for (const child of nativeRoster) {
    if (child.parentId !== meta.taskId) continue
    for (const callId of list(child.parentToolCallIds ?? [child.parentToolCallId]))
      if (typeof callId === 'string') nativeBindings.set(callId, child)
  }
  const createdAt = time(meta.createdAt) || time(messages[0].timestamp)
  const files = new Map<string, Buffer | string>(),
    warnings = new Set<string>()
  const counts = { messages: messages.length, tools: 0, thinking: 0, attachments: 0, subagents: 0 }
  const agents: Record<string, Data> = {
    [mainAgentId]: {
      homedir: join(sessionDir, 'agents', mainAgentId),
      type: mainAgentId === 'main' ? 'main' : 'sub',
      parentAgentId: null
    }
  }
  const allTools = messages.flatMap((m, mi) =>
    list(m.tools).map((v, ti) => ({ tool: object(v), mi, ti }))
  )
  const bySourceId = new Map<string, typeof allTools>()
  for (const ref of allTools) {
    const sourceId = toolId(ref.tool)
    if (sourceId) bySourceId.set(sourceId, [...(bySourceId.get(sourceId) ?? []), ref])
  }
  const children = new Map<Data, typeof allTools>()
  const parents = new Map<Data, Data>()
  for (const ref of allTools) {
    const parentId = toolParent(ref.tool)
    if (!parentId) continue
    const candidates = bySourceId.get(parentId) ?? []
    if (candidates.length !== 1)
      throw new Error(`子代理父调用 ${parentId} 缺失或重复，无法无损关联`)
    const parent = candidates[0].tool
    if (parent === ref.tool) throw new Error('工具调用存在循环父子关系')
    parents.set(ref.tool, parent)
    children.set(parent, [...(children.get(parent) ?? []), ref])
  }
  for (const ref of allTools) {
    const seen = new Set<Data>()
    let cursor: Data | undefined = ref.tool
    while (cursor) {
      if (seen.has(cursor)) throw new Error('工具调用存在循环父子关系')
      seen.add(cursor)
      cursor = parents.get(cursor)
    }
  }
  const ids = new Map<Data, string>(),
    usedIds = new Set<string>()
  for (const { tool, mi, ti } of allTools) {
    const sourceId = toolId(tool)
    const callId =
      sourceId && /^[A-Za-z0-9_-]+$/.test(sourceId) && !usedIds.has(sourceId)
        ? sourceId
        : `call_navo_${digest(`${id}:${mi}:${ti}`).slice(0, 24)}`
    ids.set(tool, callId)
    usedIds.add(callId)
    if (sourceId && sourceId !== callId)
      warnings.add('重复或不规范的工具 ID 已重建；原始 ID 保留在源副本。')
  }
  function media(attachment: Data): Part[] {
    const name = basename(text(attachment.filename) || text(attachment.name) || 'attachment')
    const mime = text(attachment.mimeType) || text(attachment.mime_type)
    const base64 = text(attachment.dataBase64) || text(attachment.data)
    if (!mime || !base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64.replace(/\s/g, '')))
      throw new Error(`附件 ${name} 缺少有效的 MIME 类型或内嵌数据，无法完整迁移`)
    const bytes = Buffer.from(base64, 'base64')
    if (
      !bytes.length ||
      bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/\s/g, '').replace(/=+$/, '')
    )
      throw new Error(`附件 ${name} 的 base64 数据损坏`)
    const fileId = `f_${digest(Buffer.concat([Buffer.from(mime + '\0' + name + '\0'), bytes]))}`
    const suffix = extname(name)
    const ext = /^\.[a-zA-Z0-9]{1,10}$/.test(suffix) ? suffix : '.bin'
    const key = `${fileId}${ext}`
    files.set(`media/${key}`, bytes)
    files.set(`media/meta/${fileId}.json`, json({ version: 1, key, name, mediaType: mime }))
    counts.attachments++
    if (mime.startsWith('image/'))
      return [{ type: 'image_url', imageUrl: { url: `kimi-file://${fileId}`, name } }]
    if (mime.startsWith('video/'))
      return [{ type: 'video_url', videoUrl: { url: `kimi-file://${fileId}`, name } }]
    // Kimi audio uses audio_url; keeping a data URL also works without the original Zcode file.
    if (mime.startsWith('audio/'))
      return [
        { type: 'audio_url', audioUrl: { url: `data:${mime};base64,${bytes.toString('base64')}` } }
      ]
    throw new Error(`附件 ${name} 的类型 ${mime} 暂无完整的 Kimi 媒体映射`)
  }
  function outputParts(value: unknown): Part[] {
    if (typeof value === 'string') return [{ type: 'text', text: value }]
    if (Array.isArray(value))
      return value.flatMap((v) => {
        const part = object(v)
        if (part.type === 'content') return outputParts(part.content)
        if (part.type === 'text' && typeof part.text === 'string')
          return [{ type: 'text', text: part.text } as Part]
        if (part.type === 'image' && typeof part.data === 'string')
          return media({ ...part, filename: 'tool-image', mimeType: part.mimeType })
        return [{ type: 'text', text: json(v) } as Part]
      })
    const o = object(value)
    if (typeof o.content === 'string' && typeof o.success === 'boolean') {
      if (o.truncated === true)
        warnings.add(
          'Zcode 已截断部分工具输出；已保留现有内容与截断标记，无法恢复源文件中不存在的字节。'
        )
      return [
        { type: 'text', text: o.content },
        ...(o.truncated === true
          ? [
              {
                type: 'text' as const,
                text: `\n[源输出已截断：originalBytes=${json(o.originalBytes)}, returnedBytes=${json(o.returnedBytes)}${o.artifactPath ? `, artifactPath=${json(o.artifactPath)}` : ''}]`
              }
            ]
          : [])
      ]
    }
    if (o.type === 'text' && typeof o.text === 'string') return [{ type: 'text', text: o.text }]
    if (typeof o.formatted_output === 'string')
      return [
        { type: 'text', text: o.formatted_output },
        ...(o.exit_code !== undefined
          ? [{ type: 'text' as const, text: `\n[exit_code: ${json(o.exit_code)}]` }]
          : [])
      ]
    return [{ type: 'text', text: value === undefined || value === null ? '' : json(value) }]
  }
  function resultOf(tool: Data) {
    const r = object(tool.raw)
    const value = tool.output ?? r.rawOutput ?? r.content
    const status = text(tool.status) || text(r.status)
    if (!['completed', 'failed'].includes(status)) {
      warnings.add('未完成的工具调用已封闭为中断结果，未将其标记为成功。')
      return {
        output: [
          ...outputParts(value),
          {
            type: 'text' as const,
            text: '\n[Zcode 调用未完成；迁移时没有最终结果，不能假定已成功执行。]'
          }
        ],
        isError: true
      }
    }
    if (value === undefined) {
      warnings.add('部分工具缺少结果，已明确标记为不可用。')
      return {
        output: [{ type: 'text' as const, text: '[Zcode 未保存此工具的结果。]' }],
        isError: true
      }
    }
    return {
      output: outputParts(value),
      isError:
        status === 'failed' || object(value).isError === true || object(value).success === false
    }
  }
  const makeWriter = (agentId: string, start: number) => {
    const records: Data[] = [{ type: 'metadata', protocol_version: '1.5', created_at: start }]
    let turn = -1,
      step = 0,
      lastTime = start,
      outcome: Outcome = 'cancelled',
      promptId = '',
      opened = false,
      stepId = ''
    const emit = (type: string, fields: Data, at = lastTime) => {
      lastTime = Math.max(lastTime, at)
      records.push({ type, agentId, ...fields, time: lastTime })
    }
    const loop = (event: Data, at = lastTime) => emit('context.append_loop_event', { event }, at)
    const closeStep = () => {
      if (opened) {
        loop({ type: 'step.end', uuid: stepId, turnId: String(turn), step, finishReason: 'stop' })
        opened = false
      }
    }
    const endTurn = () => {
      if (turn < 0) return
      closeStep()
      emit('turn.ended', { turnId: turn, reason: outcome })
      if (promptId)
        emit('prompt.completed', {
          promptId,
          reason: outcome,
          finishedAt: new Date(lastTime).toISOString()
        })
    }
    const beginTurn = (content: Part[], at: number, source: string, orphan = false) => {
      endTurn()
      turn++
      step = 0
      outcome = 'cancelled'
      promptId = `msg_navo_${digest(`${id}:${agentId}:${source}`).slice(0, 24)}`
      const origin = orphan ? { kind: 'system_trigger', name: 'imported_orphan' } : { kind: 'user' }
      if (!orphan) emit('prompt.accepted', { promptId, content }, at)
      emit('turn.prompt', { input: content, origin, promptId, turnId: turn }, at)
      if (!orphan)
        emit(
          'context.append_message',
          { message: { id: promptId, role: 'user', content, toolCalls: [], origin } },
          at
        )
    }
    const beginStep = (at: number) => {
      if (turn < 0) beginTurn([], at, 'orphan', true)
      if (!opened) {
        step++
        stepId = `step_navo_${digest(`${id}:${agentId}:${turn}:${step}`).slice(0, 24)}`
        loop({ type: 'step.begin', uuid: stepId, turnId: String(turn), step }, at)
        opened = true
      }
    }
    const content = (part: Part, at: number) => {
      beginStep(at)
      loop({ type: 'content.part', stepUuid: stepId, turnId: String(turn), step, part }, at)
      if (part.type === 'think') counts.thinking++
    }
    const tool = (t: Data, at: number, source: string) => {
      beginStep(at)
      const callId = ids.get(t)!,
        name = toolName(t)
      if (name.startsWith('ZcodeTool_'))
        warnings.add(
          '部分工具只保存了显示标题；使用兼容的工具名，原始标题保留在工具显示信息与源副本。'
        )
      let args = t.input
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          warnings.add('部分工具参数不是 JSON；以原始字符串保留。')
        }
      }
      if (nativeBindings.has(toolId(t)) && typeof object(args).resume === 'string')
        args = {
          ...object(args),
          resume: nativeAgentId(text(object(nativeBindings.get(toolId(t))!.meta).taskId))
        }
      loop(
        {
          type: 'tool.call',
          stepUuid: stepId,
          turnId: String(turn),
          step,
          toolCallId: callId,
          name,
          args,
          display: toolDisplay(t, name)
        },
        at
      )
      const result = resultOf(t)
      const nativeChild = nativeBindings.get(toolId(t))
      if (nativeChild) {
        const childId = nativeAgentId(text(object(nativeChild.meta).taskId))
        result.output.unshift({
          type: 'text',
          text: `agent_id: ${childId}\nactual_subagent_type: ${text(object(t.input).subagent_type) || 'agent'}\nstatus: ${result.isError ? 'failed' : 'completed'}\n\n[summary]\n`
        })
      }
      const nested = children.get(t)
      if (nested?.length) {
        const childId = `agent_navo_${digest(callId).slice(0, 20)}`
        agents[childId] = {
          homedir: join(sessionDir, 'agents', childId),
          type: 'sub',
          parentAgentId: agentId,
          labels: { parentAgentId: agentId }
        }
        counts.subagents++
        const input = object(t.input)
        const task = {
          taskId: childId,
          kind: 'agent',
          agentId: childId,
          parentToolCallId: callId,
          subagentType: text(input.subagent_type) || 'agent',
          description: text(input.description) || text(t.title),
          startedAt: at,
          endedAt: null
        }
        emit('task.started', { info: { ...task, status: 'running' } }, at)
        const child = makeWriter(childId, at)
        child.beginTurn([{ type: 'text', text: text(input.prompt) || text(t.title) }], at, source)
        for (const ref of nested) child.tool(ref.tool, at, `${ref.mi}:${ref.ti}`)
        for (const part of result.output) child.content(part, at)
        child.setOutcome(result.isError ? 'failed' : 'completed')
        child.endTurn()
        files.set(`agents/${childId}/wire.jsonl`, child.serialize())
        emit(
          'task.terminated',
          { info: { ...task, status: result.isError ? 'failed' : 'completed', endedAt: at } },
          at
        )
      } else if ((name === 'Agent' || name === 'Task') && !meta.sourceDatabase)
        warnings.add('部分子代理缺少独立记录，已保留调用与汇总结果。')
      loop({ type: 'tool.result', toolCallId: callId, result }, at)
      counts.tools++
      if ((name === 'TodoWrite' || name === 'TodoList') && !result.isError) {
        const input = object(t.input),
          items = list(input.todos ?? input.items).map((v) => {
            const item = object(v)
            return {
              title: text(item.content) || text(item.title),
              status: item.status === 'completed' ? 'done' : item.status
            }
          })
        if (
          items.every(
            (item) => item.title && ['pending', 'in_progress', 'done'].includes(text(item.status))
          )
        )
          emit('tools.update_store', { key: 'todo', value: items }, at)
      }
      closeStep()
    }
    const notification = (notice: Data, at: number, sourceId: string) => {
      closeStep()
      const taskId = nativeAgentId(text(notice.sourceSessionId))
      const status = notice.status === 'cancelled' ? 'killed' : notice.status
      const content = [
        {
          type: 'text',
          text: `<notification type="task.${status}" source_id="${taskId}">\nTitle: ${text(notice.summary)}\nSeverity: info\n\n<answer>\n${text(notice.result)}\n</answer>\n</notification>`
        }
      ]
      emit(
        'context.append_message',
        {
          message: {
            id: `msg_navo_${digest(sourceId).slice(0, 24)}`,
            role: 'user',
            content,
            toolCalls: [],
            origin: { kind: 'task', taskId, status, notificationId: sourceId }
          }
        },
        at
      )
    }
    return {
      notification,
      beginTurn,
      endTurn,
      content,
      tool,
      closeStep,
      setOutcome: (v: Outcome) => {
        outcome = v
      },
      getOutcome: () => outcome,
      advance: (at: number) => {
        lastTime = Math.max(lastTime, at)
      },
      serialize: () => records.map(json).join('\n') + '\n'
    }
  }
  const writer = makeWriter(mainAgentId, createdAt)
  let lastPrompt = '',
    lastTime = createdAt
  for (const [mi, m] of messages.entries()) {
    const at = time(m.timestamp) || lastTime
    if (m.role === 'user' && m.taskNotification) {
      writer.notification(object(m.taskNotification), at, text(m.sourceMessageId) || `${id}:${mi}`)
    } else if (m.role === 'user') {
      lastPrompt = text(m.content)
      const content: Part[] = lastPrompt ? [{ type: 'text', text: lastPrompt }] : []
      for (const value of list(m.attachments)) content.push(...media(object(value)))
      writer.beginTurn(content, at, String(mi))
    } else {
      const refs = allTools.filter((ref) => ref.mi === mi)
      const parts = list(m.parts).map(object),
        referenced = new Set<number>()
      const start = Math.max(lastTime, at - time(m.durationMs))
      if (parts.length) {
        for (const part of parts) {
          if (part.type === 'content' || part.type === 'thought') {
            if (typeof part.content !== 'string') throw new Error('parts 中包含非文本内容')
            if (part.content)
              writer.content(
                part.type === 'thought'
                  ? { type: 'think', think: part.content }
                  : { type: 'text', text: part.content },
                start
              )
          } else if (part.type === 'tool-call') {
            if (
              !Number.isInteger(part.toolIndex) ||
              !refs[Number(part.toolIndex)] ||
              referenced.has(Number(part.toolIndex))
            )
              throw new Error('parts 中工具索引缺失或重复，无法保持原始顺序')
            const ref = refs[Number(part.toolIndex)]
            referenced.add(ref.ti)
            if (!parents.has(ref.tool)) writer.tool(ref.tool, start, `${mi}:${ref.ti}`)
          } else throw new Error(`未知 Zcode part 类型：${text(part.type)}；拒绝丢弃内容`)
        }
        for (const [field, kind] of [
          ['content', 'content'],
          ['thought', 'thought']
        ] as const) {
          const combined = parts
            .filter((p) => p.type === kind)
            .map((p) => text(p.content))
            .join('')
          if (text(m[field]) !== combined)
            throw new Error(`${field} 与 parts 不一致；无法确认完整顺序`)
        }
        if (referenced.size !== refs.length)
          throw new Error('parts 未引用全部工具调用；拒绝丢弃工具记录')
      } else {
        if (text(m.thought)) writer.content({ type: 'think', think: text(m.thought) }, start)
        for (const ref of refs)
          if (!parents.has(ref.tool)) writer.tool(ref.tool, start, `${mi}:${ref.ti}`)
        if (text(m.content)) writer.content({ type: 'text', text: text(m.content) }, start)
        if (refs.length) warnings.add('部分消息没有 parts 顺序信息；按思考、工具、回复顺序恢复。')
      }
      for (const value of list(m.attachments))
        for (const part of media(object(value))) writer.content(part, start)
      writer.advance(at)
      writer.closeStep()
      writer.setOutcome(
        m.interrupted === true ? 'cancelled' : m.sourceError ? 'failed' : 'completed'
      )
    }
    lastTime = Math.max(lastTime, at)
  }
  if (meta.lastError) {
    writer.setOutcome('failed')
    warnings.add('源会话记录了 lastError；最终轮次标记为失败，错误详情保留在源副本。')
  }
  writer.endTurn()
  if (counts.tools !== allTools.length)
    throw new Error(`工具数量校验失败：源 ${allTools.length}，目标 ${counts.tools}`)
  if (counts.subagents)
    warnings.add(
      '子代理仅恢复 Zcode 明确关联的工具与汇总结果；未记录的独立思考和中间文本无法重建。'
    )
  for (const warning of list(source.sourceWarnings))
    if (typeof warning === 'string') warnings.add(warning)
  let wire = writer.serialize()
  if (list(source.sourceTodos).length)
    wire +=
      json({
        type: 'tools.update_store',
        agentId: mainAgentId,
        key: 'todo',
        value: source.sourceTodos,
        time: lastTime
      }) + '\n'
  const native = list(source.nativeSubagents).map(object)
  const agentIds = new Map(
    native.map((child) => [
      text(object(child.meta).taskId),
      `agent_db_${digest(text(object(child.meta).taskId)).slice(0, 24)}`
    ])
  )
  const nativeOutcomes = new Map<string, unknown>()
  files.set(`agents/${mainAgentId}/wire.jsonl`, wire)
  for (const child of native) {
    if (!list(child.messages).length) continue
    const childMeta = object(child.meta)
    const childId = agentIds.get(text(childMeta.taskId))!
    const converted = convertZcode(
      json({ ...child, nativeAgentLinks: nativeRoster }),
      sessionDir,
      id,
      childId
    )
    nativeOutcomes.set(childId, converted.state.lastTurnReason)
    const parentAgentId = agentIds.get(text(child.parentId)) || mainAgentId
    Object.assign(agents, object(converted.state.agents))
    agents[childId].parentAgentId = parentAgentId
    agents[childId].labels = { parentAgentId }
    for (const [key, contents] of converted.files)
      if (key.startsWith('agents/') || key.startsWith('media/')) files.set(key, contents)
    for (const key of ['messages', 'tools', 'thinking', 'attachments', 'subagents'] as const)
      counts[key] += converted.counts[key]
    counts.subagents++
    for (const warning of converted.warnings) warnings.add(warning)
  }
  for (const child of native) {
    const childMeta = object(child.meta),
      childId = agentIds.get(text(childMeta.taskId))!
    if (!agents[childId]) continue
    const parentAgentId = agentIds.get(text(child.parentId)) || mainAgentId
    const key = `agents/${parentAgentId}/wire.jsonl`
    if (!files.has(key)) {
      warnings.add('部分子会话的父会话为空，已保留子会话记录。')
      continue
    }
    const info = {
      taskId: childId,
      kind: 'agent',
      agentId: childId,
      description: childMeta.title,
      parentToolCallId: child.parentToolCallId,
      startedAt: childMeta.createdAt,
      endedAt: childMeta.updatedAt
    }
    const taskRecords = [
      {
        type: 'task.started',
        agentId: parentAgentId,
        info: { ...info, status: 'running', endedAt: null },
        time: childMeta.createdAt
      },
      {
        type: 'task.terminated',
        agentId: parentAgentId,
        info: {
          ...info,
          status:
            nativeOutcomes.get(childId) === 'failed'
              ? 'failed'
              : nativeOutcomes.get(childId) === 'cancelled'
                ? 'killed'
                : 'completed'
        },
        time: childMeta.updatedAt
      }
    ]
    files.set(key, String(files.get(key)) + taskRecords.map(json).join('\n') + '\n')
  }
  wire = String(files.get(`agents/${mainAgentId}/wire.jsonl`))
  const state: Data = {
    id,
    version: 2,
    cwd: meta.workspacePath,
    archived: meta.archived === true,
    agents,
    custom: {
      navoMigration: {
        source: 'zcode',
        version: MIGRATION_VERSION,
        taskId: meta.taskId,
        fingerprint: digest(raw),
        counts,
        warnings: [...warnings]
      }
    },
    lastPrompt: lastPrompt.slice(0, 200),
    title: text(meta.title) || lastPrompt.slice(0, 100) || 'Zcode 会话',
    titleKind: 'custom',
    isCustomTitle: true,
    createdAt,
    updatedAt: time(meta.updatedAt) || lastTime,
    lastTurnReason: writer.getOutcome()
  }
  files.set('state.json', JSON.stringify(state, null, 2))
  files.set('zcode-source.json', raw)
  files.set(
    'migration-report.json',
    JSON.stringify(
      { version: MIGRATION_VERSION, counts, warnings: [...warnings], sourceMeta: meta },
      null,
      2
    )
  )
  return { state, wire, files, warnings: [...warnings], counts }
}
