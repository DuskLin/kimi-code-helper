import type { AccountQuota, QuotaWindow } from './contracts'

// 按模型系列选择 OpenCode Go 原生协议，模型 ID 由上游目录同步。
export function openCodeGoRoute(model: string): string {
  if (/^(grok-|gpt-|muse-spark-)/i.test(model)) return '/v1/responses'
  if (/^(minimax-|qwen)/i.test(model)) return '/v1/messages'
  return '/v1/chat/completions'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function window(value: unknown): QuotaWindow | null {
  const node = record(value)
  if (
    typeof node.percent !== 'number' &&
    !(typeof node.percent === 'string' && node.percent.trim())
  )
    return null
  const percent = Number(node.percent)
  if (!Number.isFinite(percent)) return null
  const used = Math.max(0, percent)
  const raw = node.resetsAt
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw)
        ? Number(raw)
        : NaN
  const reset = Number.isFinite(numeric)
    ? numeric > 0
      ? numeric * (numeric < 1e12 ? 1000 : 1)
      : NaN
    : typeof raw === 'string'
      ? Date.parse(raw)
      : NaN
  const date = new Date(reset)
  return {
    limit: 100,
    used,
    remaining: Math.max(0, 100 - used),
    resetAt: Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
}

export function parseOpenCodeGoQuota(value: unknown): AccountQuota | null {
  const usage = record(record(value).usage)
  const quota: AccountQuota = {
    fiveHour: window(usage.rolling),
    weekly: window(usage.weekly),
    monthly: window(usage.monthly),
    total: null,
    totalUnlimited: false,
    unit: 'percent'
  }
  return quota.fiveHour || quota.weekly || quota.monthly ? quota : null
}

export function openCodeSession(
  headers: Record<string, string | string[] | undefined>,
  payload: unknown
): string {
  const data = record(payload)
  let user = record(data.metadata).user_id
  if (typeof user === 'string' && user.trim().startsWith('{')) {
    try {
      user = record(JSON.parse(user)).session_id
    } catch {
      user = undefined
    }
  }
  const values = [
    headers['x-opencode-session'],
    headers['session-id'],
    headers['session_id'],
    headers['conversation_id'],
    headers['x-session-affinity'],
    headers['x-session-id'],
    headers['x-conversation-id'],
    headers['x-claude-code-session-id'],
    data.prompt_cache_key,
    user
  ]
  for (const value of values) {
    if (
      typeof value === 'string' &&
      value.trim() &&
      value.length <= 512 &&
      /^[\x20-\x7e]+$/.test(value)
    )
      return value.trim()
  }
  return ''
}
