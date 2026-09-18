import { DatabaseSync } from 'node:sqlite'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { object } from './zcode-converter'

type Row = Record<string, any>
const parse = (value: unknown): Row =>
  typeof value === 'string' ? object(JSON.parse(value)) : object(value)
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
export async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (e) {
    if (absent(e)) return false
    throw e
  }
}

export async function zcodeLocations(source: string) {
  let root = source
  if (basename(source) === 'sessions' && basename(resolve(source, '..')) === 'v2')
    root = resolve(source, '../..')
  else if (basename(source) === 'cli') root = resolve(source, '..')
  else if (basename(source) === 'db' && basename(resolve(source, '..')) === 'cli')
    root = resolve(source, '../..')
  const structured =
    (await exists(join(root, 'v2'))) || (await exists(join(root, 'cli/db/db.sqlite')))
  return {
    root,
    legacy: structured ? join(root, 'v2/sessions') : source,
    database: join(root, 'cli/db/db.sqlite'),
    index: join(root, 'v2/tasks-index.sqlite')
  }
}

export async function readTaskIndex(path: string): Promise<Row[]> {
  if (!(await exists(path))) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db
      .prepare(
        'SELECT task_id, workspace_path, title, archived, deleted, meta_json FROM tasks ORDER BY workspace_path, task_id'
      )
      .all() as Row[]
  } finally {
    db.close()
  }
}

// Implements the active conversation branch selection in Zcode's persisted-message reader.
export function activeBranch(messages: Row[], revert: Row): Row[] {
  if (!revert.targetMessageID) return messages
  const target = messages.findIndex((m) => m.id === revert.targetMessageID)
  const kept = Array.isArray(revert.keptMessageIDs)
    ? (revert.keptMessageIDs
        .map((id: string) => messages.find((m) => m.id === id))
        .filter(Boolean) as Row[])
    : target >= 0
      ? messages.slice(0, target)
      : messages
  if (revert.branchCutAfterMessageID) {
    const cut = messages.findIndex((m) => m.id === revert.branchCutAfterMessageID)
    return cut >= 0 ? [...kept, ...messages.slice(cut + 1)] : kept
  }
  if (!revert.keptMessageIDs && target < 0) return messages
  const created = messages.findIndex((m) => m.id === revert.createdMessageID)
  return created >= 0 ? [...kept, ...messages.slice(created)] : kept
}

export function parseTaskNotification(value: string) {
  if (
    !value.trim().startsWith('<task-notification>') ||
    !value.trim().endsWith('</task-notification>')
  )
    return undefined
  const field = (name: string) => value.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]
  const taskId = field('task-id'),
    callId = field('tool-use-id'),
    status = field('status')
  if (!taskId || !callId || !['completed', 'failed', 'cancelled', 'killed'].includes(status || ''))
    return undefined
  const decode = (text: string) =>
    text
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
  return {
    sourceSessionId: `sess_subagent_${taskId}`,
    callId,
    status,
    summary: decode(field('summary') || ''),
    result: field('result') || ''
  }
}

export class ZcodeDatabase {
  private db: DatabaseSync
  readonly sessions: Map<string, Row>
  constructor(
    private root: string,
    file: string,
    private tasks: Row[]
  ) {
    this.db = new DatabaseSync(file, { readOnly: true })
    try {
      this.db.exec('BEGIN')
      this.sessions = new Map(
        (this.db.prepare('SELECT * FROM session ORDER BY time_created, id').all() as Row[]).map(
          (row) => [row.id, row]
        )
      )
    } catch (e) {
      this.db.close()
      throw e
    }
  }
  close() {
    this.db.close()
  }
  roots() {
    const indexed = new Set(this.tasks.filter((task) => !task.deleted).map((task) => task.task_id))
    const deleted = new Set(this.tasks.filter((task) => task.deleted).map((task) => task.task_id))
    return [...this.sessions.values()].filter(
      (row) =>
        !deleted.has(row.id) &&
        (indexed.has(row.id) || (!row.parent_id && !row.id.startsWith('sess_subagent_')))
    )
  }
  async read(id: string) {
    if (!this.sessions.has(id)) throw new Error('Zcode 数据库会话不存在')
    const visited = new Set<string>()
    const snapshots: Row[] = []
    const normalized: Row[] = []
    const warnings = new Set<string>()
    const readOne = async (sessionId: string, parentId?: string) => {
      if (visited.has(sessionId)) throw new Error('数据库子会话关联存在循环或重复')
      visited.add(sessionId)
      const session = this.sessions.get(sessionId)!
      const messageRows = this.db
        .prepare('SELECT * FROM message WHERE session_id = ? ORDER BY sequence, time_created, id')
        .all(sessionId) as Row[]
      const partRows = this.db
        .prepare('SELECT * FROM part WHERE session_id = ? ORDER BY sequence, time_created, id')
        .all(sessionId) as Row[]
      const todos = this.db
        .prepare('SELECT * FROM todo WHERE session_id = ? ORDER BY position')
        .all(sessionId) as Row[]
      snapshots.push({ session, messages: messageRows, parts: partRows, todos })
      const task = this.tasks.find(
        (t) => t.task_id === sessionId && t.workspace_path === session.directory
      )
      const messages: Row[] = []
      const linkedChildren = new Map<string, string>()
      const partsByMessage = new Map<string, Row[]>()
      for (const row of partRows) {
        const parts = partsByMessage.get(row.message_id) ?? []
        parts.push({ ...parse(row.data), _row: row })
        partsByMessage.set(row.message_id, parts)
      }
      const branch = activeBranch(messageRows, parse(session.revert))
      if (branch.length !== messageRows.length)
        warnings.add('已按 Zcode 当前分支排除撤回消息；完整原记录保留在数据库快照。')
      for (const row of branch) {
        const data = parse(row.data)
        if (!['user', 'assistant'].includes(data.role))
          throw new Error(`未知数据库消息角色：${data.role}`)
        const message: Row = {
          role: data.role,
          content: '',
          thought: '',
          parts: [],
          tools: [],
          attachments: [],
          timestamp: data.time?.completed ?? row.time_created,
          sourceMessageId: row.id
        }
        if (data.time?.completed && data.time?.created)
          message.durationMs = data.time.completed - data.time.created
        if (data.error) {
          message.interrupted = data.error.name?.includes('Abort')
          message.sourceError = data.error
        }
        for (const part of partsByMessage.get(row.id) ?? []) {
          switch (part.type) {
            case 'text':
            case 'reasoning': {
              if (typeof part.text !== 'string') throw new Error('数据库文本 part 格式无效')
              if (part.ignored) {
                warnings.add('Zcode 标记 ignored 的内容保留在快照，不加入活动对话。')
                break
              }
              const type = part.type === 'reasoning' ? 'thought' : 'content'
              message[type === 'thought' ? 'thought' : 'content'] += part.text
              message.parts.push({ type, content: part.text })
              break
            }
            case 'tool': {
              const state = object(part.state)
              if (!part.callID || !part.tool) throw new Error('数据库工具调用缺少 ID 或名称')
              const tool = {
                name: part.tool,
                title: state.title || part.tool,
                status: state.status === 'error' ? 'failed' : state.status,
                input: state.input,
                output: state.output ?? state.error,
                raw: { toolCallId: part.callID, name: part.tool },
                sourceState: state
              }
              message.parts.push({ type: 'tool-call', toolIndex: message.tools.length })
              message.tools.push(tool)
              if (
                object(state.metadata).serialization &&
                object(object(state.metadata).serialization).truncated
              )
                warnings.add(
                  'Zcode 保存的部分工具输出已截断；截断信息及 artifact 引用保留在数据库快照。'
                )
              if (part.tool === 'Agent') {
                try {
                  const output = parse(state.output)
                  const child =
                    output.sessionId ??
                    (output.agentId ? `sess_subagent_${output.agentId}` : undefined)
                  if (child && this.sessions.has(child)) linkedChildren.set(child, part.callID)
                } catch {
                  /* Most current Agent outputs contain only the final reply. Parent IDs remain authoritative. */
                }
              }
              break
            }
            case 'file': {
              const attachment = await this.attachment(part, warnings)
              if (attachment) message.attachments.push(attachment)
              else if (typeof part.url === 'string') {
                const content = `\n[附件引用：${part.filename || part.url}]`
                message.content += content
                message.parts.push({ type: 'content', content })
              }
              break
            }
            case 'step-start':
            case 'step-finish':
              break
            case 'compaction':
            case 'timeline':
              warnings.add('上下文压缩时间线保留在数据库快照；导入当前分支完整对话与已有摘要。')
              break
            default:
              throw new Error(`未支持的数据库 part 类型：${part.type}`)
          }
        }
        if (data.role === 'user' && data.synthetic === true && data.source === 'background_task') {
          const notification = parseTaskNotification(message.content)
          if (notification && this.sessions.has(notification.sourceSessionId))
            message.taskNotification = notification
        }
        if (data.error) {
          const content = `\n[Zcode 生成错误：${JSON.stringify(data.error)}]`
          message.content += content
          message.parts.push({ type: 'content', content })
        }
        if (
          message.content ||
          message.thought ||
          message.tools.length ||
          message.attachments.length
        )
          messages.push(message)
      }
      const result: Row = {
        meta: {
          taskId: sessionId,
          workspacePath: session.directory,
          title: task?.title || session.title,
          createdAt: session.time_created,
          updatedAt: session.time_updated,
          archived: task ? Boolean(task.archived) : Boolean(session.time_archived),
          sourceDatabase: true
        },
        messages,
        sourceTodos: todos.map((t) => ({
          title: t.content,
          status: t.status === 'completed' ? 'done' : t.status
        })),
        parentId
      }
      normalized.push(result)
      const children = [...this.sessions.values()].filter(
        (child) => child.parent_id === sessionId || linkedChildren.has(child.id)
      )
      for (const child of children) {
        if (child.id === id) throw new Error('数据库子会话关联存在循环')
        await readOne(child.id, sessionId)
        normalized.find((n) => n.meta.taskId === child.id)!.parentToolCallId = linkedChildren.get(
          child.id
        )
      }
      const childRecords = children.map((child) =>
        normalized.find((n) => n.meta.taskId === child.id)!
      )
      const calls = messages
        .flatMap((message) => message.tools)
        .filter((tool) => tool.name === 'Agent' || tool.name === 'Task')
      const childPrompt = (child: Row) =>
        child.messages.find((message: Row) => message.role === 'user')?.content
      // A direct parent plus a unique exact prompt match recovers links when Zcode replaces
      // an Agent JSON result with just the agent's final reply. Ambiguous matches stay unlinked.
      for (const child of childRecords) {
        const links = new Set<string>(child.parentToolCallId ? [child.parentToolCallId] : [])
        for (const message of messages) {
          const notice = message.taskNotification
          if (
            notice?.sourceSessionId === child.meta.taskId &&
            calls.some((call) => call.raw.toolCallId === notice.callId)
          )
            links.add(notice.callId)
        }
        const prompt = childPrompt(child)
        if (
          prompt &&
          childRecords.filter((candidate) => childPrompt(candidate) === prompt).length === 1
        ) {
          const matches = calls.filter((call) => object(call.input).prompt === prompt)
          if (matches.length === 1) links.add(matches[0].raw.toolCallId)
        }
        for (const call of calls) {
          const resume = object(call.input).resume
          if (
            typeof resume === 'string' &&
            (resume === child.meta.taskId || `sess_subagent_${resume}` === child.meta.taskId)
          )
            links.add(call.raw.toolCallId)
        }
        child.parentToolCallIds = [...links]
        child.parentToolCallId = child.parentToolCallIds[0]
      }
      if (childRecords.some((child) => child.messages.length && !child.parentToolCallId))
        warnings.add('部分子代理记录已迁移，但源数据不足以唯一关联到具体 Agent 调用。')
      if (calls.length && !childRecords.length)
        warnings.add('部分 Agent 调用没有可恢复的独立子会话，已保留调用结果。')
      return result
    }
    const main = await readOne(id)
    return JSON.stringify({
      ...main,
      nativeSubagents: normalized.slice(1),
      sourceWarnings: [...warnings],
      databaseSnapshot: snapshots
    })
  }
  private async attachment(part: Row, warnings: Set<string>): Promise<Row | undefined> {
    let value = String(part.url ?? '')
    if (value.startsWith('zcode-artifact://')) {
      const url = new URL(value)
      const session = decodeURIComponent(url.hostname),
        artifact = decodeURIComponent(url.pathname.slice(1))
      if (!/^[A-Za-z0-9_-]+$/.test(session) || !/^tool-result-[A-Za-z0-9_-]+$/.test(artifact))
        throw new Error('无效的 Zcode artifact 引用')
      const dir = join(this.root, 'cli/artifacts', session)
      const matches = (await readdir(dir)).filter((name) => name.includes(artifact))
      if (matches.length !== 1) throw new Error('Zcode artifact 缺失或重复')
      const file = join(dir, matches[0])
      const stat = await lstat(file)
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
        throw new Error('Zcode 附件不是普通文件或超过 64 MB')
      const bytes = await readFile(file)
      value =
        bytes.subarray(0, 5).toString() === 'data:'
          ? bytes.toString()
          : `data:${part.mime};base64,${bytes.toString('base64')}`
    }
    if (value.startsWith('data:')) {
      const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value)
      if (!match) throw new Error('附件 data URL 格式无效')
      return {
        filename: part.filename || `attachment.${match[1].split('/')[1]}`,
        mimeType: match[1],
        dataBase64: match[2]
      }
    }
    // Local references can point at mutable project files or folders, not a historical attachment snapshot.
    warnings.add('部分附件只保存了本地路径引用，已保留引用；未把当前文件内容冒充历史附件。')
    return undefined
  }
}
