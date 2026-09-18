import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import {
  convertZcode,
  parseZcode as parseSource,
  MIGRATION_VERSION,
  EmptyZcodeSessionError
} from './zcode-converter'
export { convertZcode } from './zcode-converter'
import { ZcodeDatabase, zcodeLocations, readTaskIndex, exists } from './zcode-database'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  MigrationProgress,
  MigrationPaths,
  MigrationScan,
  MigrationSession,
  MigrationResult
} from '../../shared/session-migration'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const string = (v: unknown) => (typeof v === 'string' ? v : '')
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

export function workspaceKey(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const slug = (normalized.split('/').pop() ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return `wd_${!slug || slug === '.' || slug === '..' ? 'workspace' : slug}_${hash(normalized).slice(0, 12)}`
}

export class SessionMigration {
  constructor(private readonly progress: (value: MigrationProgress) => void = () => {}) {}
  defaults(): MigrationPaths {
    return { source: join(homedir(), '.zcode'), target: join(homedir(), '.kimi-code') }
  }
  private paths(input: unknown): MigrationPaths {
    const value = record(input)
    if (
      !value ||
      typeof value.source !== 'string' ||
      typeof value.target !== 'string' ||
      !isAbsolute(value.source) ||
      !isAbsolute(value.target)
    )
      throw new Error('请输入绝对路径')
    const paths = { source: resolve(value.source), target: resolve(value.target) }
    if (paths.source === paths.target) throw new Error('来源和目标目录不能相同')
    return paths
  }
  private async source(paths: MigrationPaths, key: string, database?: ZcodeDatabase) {
    const locations = await zcodeLocations(paths.source)
    if (/^sqlite:[A-Za-z0-9_-]+$/.test(key)) {
      if (!database) throw new Error('无法读取 Zcode 数据库')
      const raw = await database.read(key.slice(7))
      return { raw, ...parseSource(raw) }
    }
    const source = locations.legacy
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json$/.test(key)) throw new Error('无效的会话标识')
    for (const p of [source, join(source, key.split('/')[0]), join(source, key)]) {
      const info = await lstat(p)
      if (info.isSymbolicLink()) throw new Error('不支持符号链接会话')
      if (info.isFile() && info.size > 64 * 1024 * 1024) throw new Error('会话文件超过 64 MB')
    }
    const raw = await readFile(join(source, key), 'utf8')
    return { raw, ...parseSource(raw) }
  }
  private destination(
    paths: MigrationPaths,
    meta: Record<string, unknown>,
    legacy = false,
    fingerprint = ''
  ) {
    const id = `session_navo_zcode_${legacy ? '' : `v${MIGRATION_VERSION}_`}${hash(string(meta.workspacePath) + '\0' + string(meta.taskId) + (legacy ? '' : '\0' + fingerprint)).slice(0, 32)}`
    return { id, dir: join(paths.target, 'sessions', workspaceKey(string(meta.workspacePath)), id) }
  }
  async scan(value: unknown = this.defaults()): Promise<MigrationScan> {
    const paths = this.paths(value)
    const result: MigrationScan = { paths, sessions: [], errors: [] }
    const locations = await zcodeLocations(paths.source)
    const tasks = await readTaskIndex(locations.index)
    let database: ZcodeDatabase | undefined
    const available = new Set<string>()
    const candidates: string[] = []
    try {
      if (await exists(locations.database)) {
        try {
          database = new ZcodeDatabase(locations.root, locations.database, tasks)
          for (const id of database.sessions.keys()) available.add(id)
          candidates.push(...database.roots().map((row) => `sqlite:${row.id}`))
        } catch (e) {
          result.errors.push(`无法读取 Zcode 数据库：${(e as Error).message}`)
        }
      }
      if (await exists(locations.legacy)) {
        for (const dir of await readdir(locations.legacy, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue
          for (const file of await readdir(join(locations.legacy, dir.name), {
            withFileTypes: true
          })) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue
            const key = `${dir.name}/${file.name}`
            try {
              const metadata = record(
                record(JSON.parse(await readFile(join(locations.legacy, key), 'utf8'))).meta
              )
              for (const alias of [metadata.taskId, metadata.acpSessionId])
                if (typeof alias === 'string') available.add(alias)
              if (
                database?.sessions.has(string(metadata.taskId)) ||
                database?.sessions.has(string(metadata.acpSessionId))
              )
                continue
              const task = tasks.find(
                (t) => t.task_id === metadata.taskId || t.task_id === metadata.acpSessionId
              )
              if (task?.deleted) continue
            } catch {
              /* The regular reader below reports invalid files. */
            }
            candidates.push(key)
          }
        }
      } else if (!database)
        result.errors.push('无法读取 Zcode 会话目录：未找到旧会话目录或 CLI 数据库')
      let completed = 0
      this.progress({ phase: 'scan', completed, total: candidates.length })
      for (const key of candidates) {
        try {
          const { raw, meta, messages } = await this.source(paths, key, database)
          const dest = this.destination(paths, meta, false, hash(raw))
          const imported = await exists(dest.dir)
          const legacyImported = await exists(this.destination(paths, meta, true).dir)
          const converted = convertZcode(raw, dest.dir, dest.id)
          result.sessions.push({
            key,
            fingerprint: hash(raw),
            title: string(meta.title) || 'Zcode 会话',
            workspace: string(meta.workspacePath),
            updatedAt: time(meta.updatedAt),
            messageCount: messages.length,
            imported,
            legacyImported,
            warnings: converted.warnings,
            counts: converted.counts
          })
        } catch (e) {
          if (e instanceof EmptyZcodeSessionError) continue
          result.errors.push(`${key}: ${(e as Error).message}`)
        } finally {
          this.progress({ phase: 'scan', completed: ++completed, total: candidates.length })
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const activeTasks = tasks.filter((t) => !t.deleted)
      const unmatched = activeTasks.filter((t) => !available.has(t.task_id))
      for (const task of unmatched)
        result.errors.push(
          `索引中的会话未找到原始记录：${task.workspace_path} / ${task.title || task.task_id}`
        )
      result.coverage = {
        indexed: activeTasks.length,
        matched: activeTasks.length - unmatched.length,
        sources: [
          ...(database ? ['CLI 数据库'] : []),
          ...(candidates.some((key) => !key.startsWith('sqlite:')) ? ['旧版 JSON'] : [])
        ]
      }
    } finally {
      database?.close()
    }
    result.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return result
  }
  importRequest(value: unknown) {
    const request = record(value)
    if (
      !Array.isArray(request.sessions) ||
      request.sessions.some(
        (s: unknown) =>
          typeof record(s).key !== 'string' || typeof record(s).fingerprint !== 'string'
      )
    )
      throw new Error('无效的会话选择')
    return this.migrate(this.paths(request.paths), request.sessions)
  }
  async migrate(
    value: MigrationPaths,
    selected: Pick<MigrationSession, 'key' | 'fingerprint'>[]
  ): Promise<MigrationResult> {
    const paths = this.paths(value)
    if (!Array.isArray(selected) || !selected.length || selected.length > 1000)
      throw new Error('请选择 1–1000 个会话')
    await mkdir(paths.target, { recursive: true, mode: 0o700 })
    const lock = join(paths.target, '.navo-zcode-migration.lock')
    await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('迁移正在进行，或上次意外退出遗留锁文件，请检查 .navo-zcode-migration.lock')
      throw e
    })
    const result: MigrationResult = {
      imported: 0,
      skipped: 0,
      errors: [],
      warnings: [],
      completedKeys: []
    }
    let database: ZcodeDatabase | undefined
    try {
      if (selected.some((item) => item.key.startsWith('sqlite:'))) {
        const locations = await zcodeLocations(paths.source)
        database = new ZcodeDatabase(
          locations.root,
          locations.database,
          await readTaskIndex(locations.index)
        )
      }
      let completed = 0
      this.progress({ phase: 'migrate', completed, total: selected.length })
      for (const item of selected) {
        let staging = ''
        try {
          const { raw, meta } = await this.source(paths, item.key, database)
          if (hash(raw) !== item.fingerprint) throw new Error('会话已变化，请重新扫描后迁移')
          const { id, dir } = this.destination(paths, meta, false, hash(raw))
          let exists = false
          try {
            await lstat(dir)
            exists = true
          } catch (e) {
            if (!missing(e)) throw e
          }
          if (exists) {
            const state = record(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')))
            const provenance = record(record(state.custom).navoMigration)
            if (
              provenance.source !== 'zcode' ||
              provenance.taskId !== meta.taskId ||
              provenance.version !== MIGRATION_VERSION
            )
              throw new Error('目标已存在且不是本工具导入的会话')
          } else {
            staging = join(paths.target, `.navo-import-${randomUUID()}`)
            const converted = convertZcode(raw, dir, id)
            for (const [relative, contents] of converted.files) {
              const destination = join(staging, relative)
              await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
              await writeFile(destination, contents, { mode: 0o600 })
            }
            result.warnings.push(
              ...converted.warnings.map(
                (warning) => `${string(meta.title) || item.key}: ${warning}`
              )
            )
            await mkdir(join(dir, '..'), { recursive: true, mode: 0o700 })
            await rename(staging, dir)
            staging = ''
          }
          // Retry registration even when the session directory already exists after an interrupted import.
          const indexPath = join(paths.target, 'session_index.jsonl')
          let index = ''
          try {
            index = await readFile(indexPath, 'utf8')
          } catch (e) {
            if (!missing(e)) throw e
          }
          if (
            !index.split('\n').some((line) => {
              try {
                return JSON.parse(line).sessionId === id
              } catch {
                return false
              }
            })
          )
            await appendFile(
              indexPath,
              (index && !index.endsWith('\n') ? '\n' : '') +
                JSON.stringify({ sessionId: id, sessionDir: dir, workDir: meta.workspacePath }) +
                '\n',
              { mode: 0o600 }
            )
          const dirty = join(paths.target, 'sessions/.index-dirty')
          await mkdir(dirty, { recursive: true, mode: 0o700 })
          await writeFile(join(dirty, `${id}.${Date.now()}`), '', { mode: 0o600 })
          if (exists) result.skipped++
          else result.imported++
          result.completedKeys.push(item.key)
        } catch (e) {
          result.errors.push(`${item?.key ?? '未知会话'}: ${(e as Error).message}`)
        } finally {
          if (staging) await rm(staging, { recursive: true, force: true })
          this.progress({ phase: 'migrate', completed: ++completed, total: selected.length })
        }
      }
      return result
    } finally {
      database?.close()
      await rm(lock, { force: true })
    }
  }
}
