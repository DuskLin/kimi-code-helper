import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RequestHistoryPage, RequestRecord } from '../../shared/contracts'
import type { UsageQuery, UsageStats, UsageTotals } from '../../shared/usage'
import { localDayKey } from '../../shared/usage'

/** 永久保存请求摘要；按游标分页，避免将全部历史加载进内存。 */
export class RequestHistory {
  private db: DatabaseSync
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_time ON requests(json_extract(record, '$.time'));
      CREATE INDEX IF NOT EXISTS requests_model ON requests(json_extract(record, '$.model'));
      CREATE INDEX IF NOT EXISTS requests_account ON requests(COALESCE(json_extract(record, '$.accountId'), json_extract(record, '$.account')), json_extract(record, '$.account'));
    `)
  }
  append(record: RequestRecord): void {
    this.db
      .prepare('INSERT INTO requests (id, record) VALUES (?, ?)')
      .run(record.id, JSON.stringify(record))
  }
  page(before?: number): RequestHistoryPage {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw new Error('请求记录游标无效')
    const rows = (
      before === undefined
        ? this.db.prepare('SELECT seq, record FROM requests ORDER BY seq DESC LIMIT 11').all()
        : this.db
            .prepare('SELECT seq, record FROM requests WHERE seq < ? ORDER BY seq DESC LIMIT 11')
            .all(before)
    ) as { seq: number; record: string }[]
    const records = rows.slice(0, 10)
    return {
      records: records.map((row) => JSON.parse(row.record) as RequestRecord),
      nextCursor: rows.length > 10 ? records.at(-1)!.seq : null,
      total: Number(this.db.prepare('SELECT COUNT(*) AS total FROM requests').get()!.total)
    }
  }
  close(): void {
    this.db.close()
  }
  usage(query: UsageQuery): UsageStats {
    if (query?.allHistory !== undefined && typeof query.allHistory !== 'boolean')
      throw new Error('统计时间范围无效')
    if (
      !query ||
      !Number.isSafeInteger(query.start) ||
      !Number.isSafeInteger(query.end) ||
      query.start < 0 ||
      query.end <= query.start ||
      query.end - query.start > 366 * 86400000 ||
      ![3600000, 86400000].includes(query.bucketMs) ||
      (query.end - query.start) / query.bucketMs > 366
    )
      throw new Error('统计时间范围无效')
    if (query.allHistory && query.bucketMs === 86400000) {
      const earliest = this.db
        .prepare("SELECT MIN(json_extract(record, '$.time')) AS time FROM requests")
        .get()!
      if (earliest.time != null && Number(earliest.time) < query.start) {
        const start = new Date(Number(earliest.time))
        start.setHours(0, 0, 0, 0)
        start.setDate(1)
        query = { ...query, start: start.getTime() }
      }
    }
    for (const value of [query.accountId, query.model])
      if (value !== undefined && (typeof value !== 'string' || value.length > 200))
        throw new Error('统计筛选条件无效')
    if (query.protocol && !['responses', 'chat-completions', 'messages'].includes(query.protocol))
      throw new Error('统计来源无效')
    const values: (number | string)[] = [query.start, query.end]
    let where = "WHERE json_extract(record, '$.time') >= ? AND json_extract(record, '$.time') < ?"
    for (const [field, value] of [
      ['accountId', query.accountId],
      ['model', query.model],
      ['protocol', query.protocol]
    ] as const) {
      if (value) {
        where +=
          field === 'accountId'
            ? " AND COALESCE(json_extract(record, '$.accountId'), json_extract(record, '$.account')) = ?"
            : ` AND json_extract(record, '$.${field}') = ?`
        values.push(value)
      }
    }
    const speedEligible =
      "json_extract(record, '$.status') >= 200 AND json_extract(record, '$.status') < 300 AND json_extract(record, '$.interruption') IS NULL AND json_extract(record, '$.streamDurationMs') > 0 AND json_extract(record, '$.usage.output') IS NOT NULL"
    const tokenSum =
      "COALESCE(json_extract(record, '$.usage.input'), 0) + COALESCE(json_extract(record, '$.usage.output'), 0) + COALESCE(json_extract(record, '$.usage.cacheRead'), 0) + COALESCE(json_extract(record, '$.usage.cacheWrite'), 0)"
    const tokensKnown =
      "(json_extract(record, '$.usage.input') IS NOT NULL OR json_extract(record, '$.usage.output') IS NOT NULL OR json_extract(record, '$.usage.cacheRead') IS NOT NULL OR json_extract(record, '$.usage.cacheWrite') IS NOT NULL)"
    const clientInterrupted =
      "(json_extract(record, '$.interruption') = 'client_disconnect' OR (json_type(record, '$.interruption') IS NULL AND json_extract(record, '$.status') = 499))"
    const interrupted = `(${clientInterrupted} OR json_extract(record, '$.interruption') IN ('timeout', 'upstream_disconnect', 'upstream_error', 'gateway_shutdown'))`
    const aggregate = `COUNT(*) AS requests,
      SUM(CASE WHEN ${clientInterrupted} THEN 1 ELSE 0 END) AS interruptedClient,
      SUM(CASE WHEN json_extract(record, '$.interruption') = 'timeout' THEN 1 ELSE 0 END) AS interruptedTimeout,
      SUM(CASE WHEN json_extract(record, '$.interruption') IN ('upstream_disconnect', 'upstream_error') THEN 1 ELSE 0 END) AS interruptedUpstream,
      SUM(CASE WHEN json_extract(record, '$.interruption') = 'gateway_shutdown' THEN 1 ELSE 0 END) AS interruptedShutdown,
      SUM(CASE WHEN ${speedEligible} THEN json_extract(record, '$.usage.output') ELSE 0 END) AS speedOutput,
      SUM(CASE WHEN ${speedEligible} THEN json_extract(record, '$.streamDurationMs') ELSE 0 END) AS speedMs,
      SUM(CASE WHEN ${speedEligible} THEN 1 ELSE 0 END) AS speedSamples,
      SUM(CASE WHEN ${interrupted} THEN 1 ELSE 0 END) AS interruptedRequests,
      SUM(CASE WHEN ${interrupted} AND ${tokensKnown} THEN 1 ELSE 0 END) AS interruptedReported,
      SUM(CASE WHEN ${interrupted} AND ${tokensKnown} THEN ${tokenSum} ELSE NULL END) AS interruptedTokens,
      SUM(CASE WHEN ${interrupted} THEN json_extract(record, '$.usage.cost') ELSE NULL END) AS interruptedCost,
      SUM(CASE WHEN json_type(record, '$.usage') = 'object' THEN 1 ELSE 0 END) AS reported,
      SUM(json_extract(record, '$.usage.input')) AS input,
      SUM(json_extract(record, '$.usage.output')) AS output,
      SUM(json_extract(record, '$.usage.cacheRead')) AS cacheRead,
      SUM(json_extract(record, '$.usage.cacheWrite')) AS cacheWrite,
      SUM(json_extract(record, '$.usage.cost')) AS cost`
    const totals = (row: Record<string, unknown>): UsageTotals => {
      const num = (key: string): number | null => (row[key] == null ? null : Number(row[key]))
      const input = num('input'),
        output = num('output'),
        cacheRead = num('cacheRead'),
        cacheWrite = num('cacheWrite')
      const known = [input, output, cacheRead, cacheWrite].some((v) => v !== null)
      const denominator = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      return {
        averageTokensPerSecond:
          Number(row.speedMs ?? 0) > 0
            ? (Number(row.speedOutput) * 1000) / Number(row.speedMs)
            : null,
        speedSamples: Number(row.speedSamples ?? 0),
        interruptedRequests: Number(row.interruptedRequests ?? 0),
        interruptionCounts: {
          client: Number(row.interruptedClient ?? 0),
          timeout: Number(row.interruptedTimeout ?? 0),
          upstream: Number(row.interruptedUpstream ?? 0),
          shutdown: Number(row.interruptedShutdown ?? 0)
        },
        interruptedReported: Number(row.interruptedReported ?? 0),
        interruptedTokens: num('interruptedTokens'),
        interruptedCost: num('interruptedCost'),
        requests: Number(row.requests ?? 0),
        reported: Number(row.reported ?? 0),
        input,
        output,
        cacheRead,
        cacheWrite,
        cost: num('cost'),
        totalTokens: known
          ? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
          : null,
        cacheHitRate: cacheRead !== null && denominator > 0 ? cacheRead / denominator : null
      }
    }
    const summary = totals(
      this.db.prepare(`SELECT ${aggregate} FROM requests ${where}`).get(...values)!
    )
    const rows = this.db
      .prepare(
        `SELECT CAST((json_extract(record, '$.time') - ?) / ? AS INTEGER) AS bucket, ${aggregate} FROM requests ${where} GROUP BY bucket ORDER BY bucket`
      )
      .all(query.start, query.bucketMs, ...values)
    const buckets = new Map(rows.map((row) => [Number(row.bucket), totals(row)]))
    let points = Array.from(
      { length: Math.ceil((query.end - query.start) / query.bucketMs) },
      (_, i) => ({ ...totals({}), ...buckets.get(i), time: query.start + i * query.bucketMs })
    )
    if (query.bucketMs === 86400000) {
      // 本地自然日分桶，避免夏令时的 23/25 小时日偏移。
      const days = this.db
        .prepare(
          `SELECT date(json_extract(record, '$.time') / 1000, 'unixepoch', 'localtime') AS day, ${aggregate} FROM requests ${where} GROUP BY day`
        )
        .all(...values)
      const daily = new Map(days.map((row) => [String(row.day), totals(row)]))
      points = []
      for (
        const date = new Date(query.start);
        date.getTime() < query.end;
        date.setDate(date.getDate() + 1)
      ) {
        points.push({
          ...totals({}),
          ...daily.get(localDayKey(date.getTime())),
          time: date.getTime()
        })
      }
    }
    const accounts = this.db
      .prepare(
        "SELECT COALESCE(json_extract(record, '$.accountId'), json_extract(record, '$.account')) AS id, MAX(json_extract(record, '$.account')) AS name FROM requests WHERE json_extract(record, '$.account') != '' GROUP BY id ORDER BY name"
      )
      .all() as { id: string; name: string }[]
    const models = this.db
      .prepare(
        "SELECT DISTINCT json_extract(record, '$.model') AS model FROM requests WHERE json_extract(record, '$.model') != '' ORDER BY model"
      )
      .all()
      .map((row) => String(row.model))
    const byModel = this.db
      .prepare(
        `SELECT json_extract(record, '$.model') AS model, ${aggregate} FROM requests ${where} GROUP BY model ORDER BY requests DESC`
      )
      .all(...values)
      .map((row) => ({ ...totals(row), model: String(row.model || '未知模型') }))
    const firstTokenEligible =
      "json_extract(record, '$.status') >= 200 AND json_extract(record, '$.status') < 300 AND json_extract(record, '$.interruption') IS NULL AND json_type(record, '$.firstTokenMs') IN ('integer', 'real') AND json_extract(record, '$.firstTokenMs') >= 0"
    const weekday =
      "CAST(strftime('%w', json_extract(record, '$.time') / 1000, 'unixepoch', '+8 hours') AS INTEGER)"
    const hour =
      "CAST(strftime('%H', json_extract(record, '$.time') / 1000, 'unixepoch', '+8 hours') AS INTEGER)"
    const period = `CASE WHEN ${weekday} BETWEEN 1 AND 5 AND ((${hour} >= 9 AND ${hour} < 12) OR (${hour} >= 14 AND ${hour} < 18)) THEN 'peak' ELSE 'off-peak' END`
    const byAccount = this.db
      .prepare(
        `SELECT json_extract(record, '$.accountId') AS accountId, COALESCE(NULLIF(json_extract(record, '$.model'), ''), '未知模型') AS model, ${period} AS period, AVG(CASE WHEN ${firstTokenEligible} THEN json_extract(record, '$.firstTokenMs') END) AS averageFirstTokenMs, COUNT(CASE WHEN ${firstTokenEligible} THEN 1 END) AS firstTokenSamples, ${aggregate} FROM requests ${where} AND json_extract(record, '$.accountId') IS NOT NULL GROUP BY accountId, model, period ORDER BY accountId, model, period`
      )
      .all(...values)
      .map((row) => {
        const summary = totals(row)
        return {
          accountId: String(row.accountId),
          model: String(row.model),
          period: row.period === 'peak' ? ('peak' as const) : ('off-peak' as const),
          averageFirstTokenMs:
            row.averageFirstTokenMs == null ? null : Number(row.averageFirstTokenMs),
          firstTokenSamples: Number(row.firstTokenSamples),
          averageTokensPerSecond: summary.averageTokensPerSecond,
          speedSamples: summary.speedSamples
        }
      })
    return { summary, points, accounts, models, byModel, byAccount }
  }
}
