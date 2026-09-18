import { readdir, lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setImmediate as yieldLoop } from 'node:timers/promises'

export interface SessionMetrics {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number | null
  cacheHitRate: number | null
  tokensPerSecond: number | null
  speedAt: number | null
  requests: number
  agents: number
  complete: boolean
}
type Totals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
  cacheInput: number
  cacheKnownRead: number
  speed: number | null
  speedAt: number | null
}
const empty = (): Totals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
  cacheInput: 0,
  cacheKnownRead: 0,
  speed: null,
  speedAt: null
})
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

// usage.record 是实际用量；step.end 中的 usage 仅用于速率，不能再次累加。
export function consumeMetricEvent(totals: Totals, record: Record<string, any>) {
  if (record.type === 'usage.record' && record.usageScope === 'turn') {
    const u = record.usage
    if (!u || typeof u !== 'object') return
    const input = count(u.inputOther),
      output = count(u.output),
      read = count(u.inputCacheRead),
      write = count(u.inputCacheCreation)
    if ([input, output, read, write].every((v) => v === null)) return
    totals.requests++
    totals.input += input ?? 0
    totals.output += output ?? 0
    totals.cacheRead += read ?? 0
    totals.cacheWrite += write ?? 0
    if (input !== null && read !== null && write !== null) {
      totals.cacheInput += input + read + write
      totals.cacheKnownRead += read
    }
  }
  if (record.type === 'context.append_loop_event' && record.event?.type === 'step.end') {
    const e = record.event,
      output = count(e.usage?.output),
      duration = count(e.llmStreamDurationMs),
      time = count(record.time)
    if (time !== null && (totals.speedAt === null || time >= totals.speedAt)) {
      totals.speed =
        output !== null && duration !== null && duration > 0 ? output / (duration / 1000) : null
      totals.speedAt = time
    }
  }
}

type FileCache = {
  offset: number
  tail: Buffer
  skipLine: boolean
  totals: Totals
  ino: number
  mtime: number
  size: number
  complete: boolean
}

export class KimiSessionMetrics {
  private files = new Map<string, FileCache>()
  constructor(private readonly root = join(homedir(), '.kimi-code/sessions')) {}

  private async directories(path: string) {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
  }
  async snapshot(): Promise<Record<string, SessionMetrics>> {
    const result: Record<string, SessionMetrics> = {}
    const seen = new Set<string>()
    let budget = 16 * 1024 * 1024
    for (const workspace of await this.directories(this.root)) {
      for (const session of await this.directories(join(this.root, workspace))) {
        if (!/^session_[a-zA-Z0-9_-]+$/.test(session)) continue
        const agentsRoot = join(this.root, workspace, session, 'agents')
        const rows: { agent: string; file: FileCache }[] = []
        for (const agent of await this.directories(agentsRoot)) {
          const path = join(agentsRoot, agent, 'wire.jsonl')
          try {
            const stat = await lstat(path)
            if (!stat.isFile()) continue
            seen.add(path)
            let cache = this.files.get(path)
            if (
              !cache ||
              stat.ino !== cache.ino ||
              stat.size < cache.offset ||
              (stat.size === cache.size && stat.mtimeMs !== cache.mtime)
            ) {
              cache = {
                offset: 0,
                tail: Buffer.alloc(0),
                skipLine: false,
                totals: empty(),
                ino: stat.ino,
                mtime: stat.mtimeMs,
                size: stat.size,
                complete: false
              }
              this.files.set(path, cache)
            }
            const bytes = Math.min(stat.size - cache.offset, budget, 4 * 1024 * 1024)
            if (bytes > 0) {
              const handle = await open(path, 'r')
              try {
                const buffer = Buffer.alloc(bytes)
                const { bytesRead } = await handle.read(buffer, 0, bytes, cache.offset)
                cache.offset += bytesRead
                budget -= bytesRead
                const combined = Buffer.concat([cache.tail, buffer.subarray(0, bytesRead)])
                let start = 0,
                  lines = 0
                for (
                  let end = combined.indexOf(10);
                  end !== -1;
                  end = combined.indexOf(10, start)
                ) {
                  if (!cache.skipLine) {
                    const line = combined.subarray(start, end).toString('utf8')
                    // 忽略消息正文，仅解析两种指标事件；不向渲染器导出会话内容。
                    if (line.includes('"usage.record"') || line.includes('"step.end"')) {
                      try {
                        consumeMetricEvent(cache.totals, JSON.parse(line))
                      } catch {}
                    }
                  }
                  cache.skipLine = false
                  start = end + 1
                  if (++lines % 128 === 0) await yieldLoop()
                }
                cache.tail = Buffer.from(combined.subarray(start))
                if (cache.tail.length > 1024 * 1024) {
                  cache.tail = Buffer.alloc(0)
                  cache.skipLine = true
                }
              } finally {
                await handle.close()
              }
            }
            cache.size = stat.size
            cache.mtime = stat.mtimeMs
            cache.complete =
              cache.offset === stat.size && !cache.skipLine && cache.tail.length === 0
            rows.push({ agent, file: cache })
          } catch {
            rows.push({
              agent,
              file: {
                offset: 0,
                tail: Buffer.alloc(0),
                skipLine: false,
                totals: empty(),
                ino: 0,
                mtime: 0,
                size: 0,
                complete: false
              }
            })
          }
        }
        if (!rows.length) continue
        const sums = empty()
        for (const { file } of rows) {
          for (const key of [
            'input',
            'output',
            'cacheRead',
            'cacheWrite',
            'requests',
            'cacheInput',
            'cacheKnownRead'
          ] as const)
            sums[key] += file.totals[key]
        }
        const complete = rows.every(({ file }) => file.complete)
        const main = rows.find(({ agent }) => agent === 'main')?.file.totals
        result[session] = {
          input: sums.input,
          output: sums.output,
          cacheRead: sums.cacheRead,
          cacheWrite: sums.cacheWrite,
          requests: sums.requests,
          agents: rows.length,
          complete,
          totalTokens:
            complete && sums.requests
              ? sums.input + sums.output + sums.cacheRead + sums.cacheWrite
              : null,
          cacheHitRate:
            complete && sums.cacheInput > 0 ? sums.cacheKnownRead / sums.cacheInput : null,
          tokensPerSecond: complete ? (main?.speed ?? null) : null,
          speedAt: main?.speedAt ?? null
        }
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path)
    return result
  }
}
