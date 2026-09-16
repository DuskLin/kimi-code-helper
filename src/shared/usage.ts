export interface TokenUsage {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  cost: number | null
}
export type UsageProtocol = 'responses' | 'chat-completions' | 'messages'
export interface UsageQuery {
  allHistory?: boolean
  start: number
  end: number
  bucketMs: number
  protocol?: UsageProtocol
  accountId?: string
  model?: string
}
export interface UsageTotals extends TokenUsage {
  averageTokensPerSecond: number | null
  speedSamples: number
  interruptedRequests: number
  interruptionCounts: { client: number; timeout: number; upstream: number; shutdown: number }
  interruptedReported: number
  interruptedTokens: number | null
  interruptedCost: number | null
  requests: number
  reported: number
  totalTokens: number | null
  cacheHitRate: number | null
}
export interface UsageStats {
  byAccount: {
    period: 'peak' | 'off-peak'
    averageFirstTokenMs: number | null
    firstTokenSamples: number
    accountId: string
    model: string
    averageTokensPerSecond: number | null
    speedSamples: number
  }[]
  byModel: (UsageTotals & { model: string })[]
  summary: UsageTotals
  points: (UsageTotals & { time: number })[]
  accounts: { id: string; name: string }[]
  models: string[]
}

export function localDayKey(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function heatmapRange(now = Date.now()): { start: number; end: number } {
  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(1)
  start.setMonth(start.getMonth() - 11)
  return { start: start.getTime(), end: end.getTime() }
}
export function heatmapLevel(tokens: number | null, maximum: number): number {
  return tokens === null || tokens <= 0
    ? 0
    : Math.min(4, Math.max(1, Math.ceil((tokens / Math.max(1, maximum)) * 4)))
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
/** 与 cc-switch 一致：OpenAI 的 input 包含缓存，Anthropic 的 input 不包含缓存。 */
export function parseUsage(value: unknown, protocol: UsageProtocol): Partial<TokenUsage> | null {
  const root = object(value)
  const u = object(object(root.response).usage ?? object(root.message).usage ?? root.usage)
  if (!Object.keys(u).length) return null
  const input = count(u.input_tokens ?? u.prompt_tokens)
  const output = count(u.output_tokens ?? u.completion_tokens)
  const read = count(
    u.cache_read_input_tokens ??
      u.prompt_cache_hit_tokens ??
      object(u.input_tokens_details ?? u.prompt_tokens_details).cached_tokens
  )
  const write = count(u.cache_creation_input_tokens)
  const result: Partial<TokenUsage> = {}
  if (input !== null)
    result.input = protocol === 'messages' ? input : Math.max(0, input - (read ?? 0) - (write ?? 0))
  if (output !== null) result.output = output
  if (read !== null) result.cacheRead = read
  if (write !== null) result.cacheWrite = write
  const cost = u.cost_usd ?? u.total_cost_usd
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) result.cost = cost
  return Object.keys(result).length ? result : null
}
