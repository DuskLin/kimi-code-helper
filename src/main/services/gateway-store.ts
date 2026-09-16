import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { storedQuota } from '../../shared/kimi-quota'
import {
  DEFAULT_ACCOUNT_CONCURRENCY,
  kimiBaseUrl,
  type AccountCapabilities,
  type AccountInput,
  type GatewaySettings,
  type GroupInput,
  type GroupView
} from '../../shared/contracts'

export interface Credential {
  accessToken: string
}
export interface StoredAccount extends Omit<AccountInput, 'id' | 'secret'> {
  id: string
  credential: Credential
  baseUrl: string
  models: string[]
  maxConcurrency: number
  capabilities: AccountCapabilities | null
}
export interface StoredGroup extends GroupView {
  key: string
}
export interface GatewayData {
  version: 1
  settings: GatewaySettings
  accounts: StoredAccount[]
  groups: StoredGroup[]
}
export interface SecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('输入格式无效')
  return value as Record<string, unknown>
}
export function string(value: unknown, label: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new Error(`${label}无效`)
  return value.trim()
}
export function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label}须为 ${min}–${max} 的整数`)
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('开关值无效')
  return value
}
export function validateGateway(value: unknown): GatewaySettings {
  const v = object(value)
  return {
    stickySeconds: integer(v.stickySeconds ?? 300, 0, 86400, '会话保持时间'),
    port: integer(v.port, 1024, 65535, '端口'),
    autoStart: boolean(v.autoStart),
    timeoutSeconds: integer(v.timeoutSeconds, 5, 1800, '请求超时'),
    maxAttempts: integer(v.maxAttempts, 1, 10, '最大尝试次数'),
    cooldownSeconds: integer(v.cooldownSeconds, 1, 3600, '冷却时间')
  }
}
export function validateGroup(value: unknown): GroupInput {
  const v = object(value)
  if (!['balanced', 'weighted-round-robin', 'least-connections'].includes(v.strategy as string))
    throw new Error('调度策略无效')
  return {
    ...(v.id !== undefined ? { id: string(v.id, '分组 ID') } : {}),
    name: string(v.name, '分组名称'),
    enabled: boolean(v.enabled),
    strategy: 'balanced',
    stickySeconds: integer(v.stickySeconds, 0, 86400, '会话保持时间')
  }
}
export function validateAccount(value: unknown, groups: StoredGroup[]): AccountInput {
  const v = object(value)
  if (v.kind !== 'api-key') throw new Error('仅支持 API Key 接入')
  if (!['mainland-cn', 'global'].includes(v.region as string)) throw new Error('账号区域无效')
  if (
    !Array.isArray(v.memberships) ||
    !v.memberships.length ||
    v.memberships.length > groups.length
  )
    throw new Error('至少选择一个有效分组')
  const memberships = v.memberships.map((item) => {
    const m = object(item)
    const groupId = string(m.groupId, '分组 ID')
    if (!groups.some((group) => group.id === groupId)) throw new Error('分组不存在')
    return {
      groupId,
      priority: integer(m.priority, 0, 1000, '优先级'),
      weight: integer(m.weight, 1, 100, '权重')
    }
  })
  if (new Set(memberships.map((m) => m.groupId)).size !== memberships.length)
    throw new Error('分组不能重复')
  const secret =
    v.secret === undefined || v.secret === '' ? undefined : string(v.secret, '凭据', 16384)
  if (secret && /[\s\x00-\x1f\x7f]/.test(secret)) throw new Error('凭据不能包含空格或控制字符')
  return {
    ...(v.id !== undefined ? { id: string(v.id, '账号 ID') } : {}),
    name: string(v.name, '账号名称'),
    kind: 'api-key',
    region: v.region as AccountInput['region'],
    enabled: boolean(v.enabled),
    ...(v.concurrencyOverride !== undefined
      ? {
          concurrencyOverride:
            v.concurrencyOverride === null
              ? null
              : integer(v.concurrencyOverride, 1, 1000, '手动并发上限')
        }
      : {}),
    memberships,
    secret
  }
}

export function capabilityFields(
  region: AccountInput['region'],
  value: unknown,
  concurrencyOverride: number | null = null
) {
  if (concurrencyOverride !== null) integer(concurrencyOverride, 1, 1000, '手动并发上限')
  let capabilities: AccountCapabilities | null = null
  if (value !== undefined && value !== null) {
    const data = object(value)
    if (!Array.isArray(data.models) || data.models.length > 2000)
      throw new Error('上游模型列表无效')
    capabilities = {
      models: [...new Set(data.models.map((model) => string(model, '模型', 200)))],
      maxConcurrency:
        data.maxConcurrency === null
          ? null
          : integer(data.maxConcurrency, 0, 100000, '上游并发上限'),
      checkedAt: integer(data.checkedAt, 0, Number.MAX_SAFE_INTEGER, '同步时间'),
      warning:
        typeof data.warning === 'string'
          ? data.warning
              .slice(0, 500)
              .replace(
                /上游未提供并发上限，暂按 \d+ 个并发调度/g,
                `未获取到并发上限，使用默认 ${DEFAULT_ACCOUNT_CONCURRENCY} 个并发调度`
              )
          : '',
      ...(data.quota !== undefined ? { quota: storedQuota(data.quota) } : {})
    }
  }
  return {
    baseUrl: kimiBaseUrl(region),
    models: capabilities?.models ?? [],
    maxConcurrency:
      concurrencyOverride ?? capabilities?.maxConcurrency ?? DEFAULT_ACCOUNT_CONCURRENCY,
    concurrencyOverride,
    capabilities
  }
}

export class GatewayStore {
  private data: GatewayData = {
    version: 1,
    settings: {
      port: 17300,
      autoStart: false,
      timeoutSeconds: 300,
      maxAttempts: 3,
      cooldownSeconds: 30
    },
    accounts: [],
    groups: [
      {
        id: 'default',
        name: '默认分组',
        enabled: true,
        strategy: 'balanced',
        stickySeconds: 300,
        key: randomBytes(32).toString('hex')
      }
    ]
  }
  private writes: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec
  ) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error('无法读取账号配置，请检查文件权限')
    }
    try {
      const envelope = object(JSON.parse(raw))
      if (envelope.version !== 1) throw new Error('配置版本无效')
      const data = object(
        JSON.parse(this.codec.decrypt(string(envelope.encrypted, '加密配置', 10_000_000)))
      )
      if (
        data.version !== 1 ||
        !Array.isArray(data.groups) ||
        !data.groups.length ||
        !Array.isArray(data.accounts)
      )
        throw new Error('配置格式无效')
      const groups = data.groups.map((g) => {
        const item = object(g)
        return {
          ...validateGroup(item),
          id: string(item.id, '分组 ID'),
          key: string(item.key, '分组密钥', 200)
        }
      })
      // 旧授权账号仅保留名称和分组，不把访问令牌当作 API Key。先保留加密备份，
      // 再迁移为停用且待填写密钥的账号；已有 API Key 账号可直接读取。
      if (data.accounts.some((a) => object(a).kind === 'oauth')) {
        try {
          await writeFile(`${this.file}.oauth-backup`, raw, { mode: 0o600, flag: 'wx' })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const accounts = data.accounts.map((a) => {
        const item = object(a)
        const legacy = item.kind === 'oauth'
        const { secret: _secret, ...input } = validateAccount(
          legacy ? { ...item, kind: 'api-key', enabled: false } : item,
          groups
        )
        const c = legacy ? { accessToken: '' } : object(item.credential)
        return {
          ...input,
          ...capabilityFields(
            input.region,
            legacy ? null : item.capabilities,
            input.concurrencyOverride
          ),
          id: string(item.id, '账号 ID'),
          credential: {
            accessToken:
              !input.enabled && c.accessToken === '' ? '' : string(c.accessToken, 'API Key', 16384)
          }
        }
      })
      if (
        new Set(groups.map((g) => g.id)).size !== groups.length ||
        new Set(accounts.map((a) => a.id)).size !== accounts.length ||
        new Set(groups.map((g) => g.key)).size !== groups.length
      )
        throw new Error('配置 ID 重复')
      if (!groups.some((g) => g.id === 'default'))
        groups.unshift({
          id: 'default',
          name: '默认分组',
          enabled: true,
          strategy: 'balanced',
          stickySeconds: 300,
          key: randomBytes(32).toString('hex')
        })
      const primary = groups.find((g) => g.id === 'default')!
      primary.enabled = true
      const settings = validateGateway({
        ...object(data.settings),
        stickySeconds: object(data.settings).stickySeconds ?? primary.stickySeconds
      })
      this.data = { version: 1, settings, groups, accounts }
    } catch {
      throw new Error('账号配置损坏或系统钥匙串不可用。原文件已保留，请恢复钥匙串或备份后重启。')
    }
  }
  get(): GatewayData {
    return structuredClone(this.data)
  }
  get historyPath(): string {
    return `${this.file}.requests.sqlite`
  }
  mutate(change: (data: GatewayData) => void): Promise<void> {
    const write = this.writes.then(async () => {
      const next = this.get()
      change(next)
      const encrypted = this.codec.encrypt(JSON.stringify(next))
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, encrypted }), {
        mode: 0o600
      })
      await rename(`${this.file}.tmp`, this.file)
      this.data = next
    })
    this.writes = write.catch(() => {})
    return write
  }
  async saveAccount(
    value: unknown,
    capabilities?: AccountCapabilities,
    expectedKey?: string
  ): Promise<string> {
    let id = ''
    await this.mutate((data) => {
      const { secret, ...input } = validateAccount(value, data.groups)
      const old = data.accounts.find((a) => a.id === input.id)
      if (input.id && !old) throw new Error('账号不存在')
      const nextCredential = secret ? { accessToken: secret } : old?.credential
      if (!nextCredential?.accessToken) throw new Error('请填写 API Key')
      if (expectedKey && nextCredential.accessToken !== expectedKey)
        throw new Error('账号凭据已变更，请重试')
      id = input.id ?? randomUUID()
      const unchanged =
        old?.region === input.region && old.credential.accessToken === nextCredential.accessToken
      const account: StoredAccount = {
        ...input,
        id,
        credential: nextCredential,
        ...capabilityFields(
          input.region,
          capabilities ?? (unchanged ? old?.capabilities : null),
          input.concurrencyOverride === undefined
            ? old?.concurrencyOverride
            : input.concurrencyOverride
        )
      }
      if (old) data.accounts[data.accounts.indexOf(old)] = account
      else data.accounts.push(account)
    })
    return id
  }
  async saveGroup(value: unknown): Promise<void> {
    await this.mutate((data) => {
      const input = validateGroup(value)
      const old = data.groups.find((g) => g.id === input.id)
      if (input.id && !old) throw new Error('分组不存在')
      if (data.groups.some((g) => g.name === input.name && g.id !== input.id))
        throw new Error('分组名称已存在')
      const group = {
        ...input,
        id: input.id ?? randomUUID(),
        key: old?.key ?? randomBytes(32).toString('hex')
      }
      if (old) data.groups[data.groups.indexOf(old)] = group
      else data.groups.push(group)
    })
  }
  async deleteAccount(value: unknown): Promise<void> {
    const id = string(value, '账号 ID')
    await this.mutate((data) => {
      data.accounts = data.accounts.filter((a) => a.id !== id)
    })
  }
  async deleteGroup(value: unknown): Promise<void> {
    const id = string(value, '分组 ID')
    await this.mutate((data) => {
      if (id === 'default') throw new Error('默认分组不能删除')
      if (data.accounts.some((a) => a.memberships.some((m) => m.groupId === id)))
        throw new Error('请先移除此分组下的账号关联')
      data.groups = data.groups.filter((g) => g.id !== id)
    })
  }
}
