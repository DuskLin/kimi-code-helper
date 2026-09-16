import type { AccountBalance } from './contracts'

export function parseDeepSeekBalance(value: unknown): AccountBalance {
  const data = value as Record<string, unknown> | null
  if (!data || !Array.isArray(data.balance_infos)) throw new Error('上游余额格式无效')
  if (data.is_available !== undefined && typeof data.is_available !== 'boolean')
    throw new Error('上游余额可用状态无效')
  const balances = data.balance_infos.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item.total_balance
    if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim())) return []
    const balance = Number(raw)
    if (!Number.isFinite(balance)) return []
    const currency = typeof item.currency === 'string' ? item.currency.trim().toUpperCase() : 'CNY'
    if (!/^[A-Z]{3}$/.test(currency)) return []
    return [{ currency, balance }]
  })
  if (!balances.length) throw new Error('上游未返回有效余额')
  return { available: data.is_available !== false, balances }
}

export function storedBalance(value: unknown): AccountBalance | null {
  if (value == null) return null
  const data = value as AccountBalance
  return parseDeepSeekBalance({
    is_available: data.available,
    balance_infos: data.balances?.map((entry) => ({
      currency: entry.currency,
      total_balance: entry.balance
    }))
  })
}
