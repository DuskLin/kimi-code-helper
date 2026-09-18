import type { TokenUsage } from './usage'

export const FLOW_IDLE_MINUTES = [5, 10, 15, 30, 60] as const

export const FLOW_IDLE_RETENTION_MS = 5 * 60 * 1000

export interface LiveFlow {
  id: string
  harness: string
  agentKey: string
  identity: 'session' | 'request'
  model: string
  startedAt: number
  updatedAt: number
  lastUploadAt?: number | null
  uploadBytes?: number
  lastActivityAt: number | null
  endedAt: number | null
  state: 'waiting' | 'streaming' | 'completed' | 'error'
  bytes: number
  usage: TokenUsage | null
}

/** Product identities, not model/provider names. See docs/harness-identification.md. */
export const HARNESSES = [
  { id: 'zcode', name: 'Zcode', product: /^(?:zcode|z-code)$/i },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    product:
      /^(?:kimi|kimicli|kimi-cli|kimi-code|kimi-code-cli|kimi-code-desktop|kimi-code-vscode|kimi_code)$/i
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    product: /^(?:claude|claude-cli|claude-code|claude_code)$/i
  },
  {
    id: 'codex',
    name: 'Codex',
    product:
      /^(?:codex|codex-cli|codex_cli|codex_cli_rs|codex-tui|codex-desktop|codex_vscode|codex_atlas|codex_chatgpt_desktop)$/i
  },
  { id: 'qoder', name: 'Qoder', product: /^(?:qoder|qodercli|qoder-cli|qoder_cli)$/i },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    product: /^(?:workbuddy|workbuddy-desktop|workbuddy-cli)$/i
  },
  { id: 'pi', name: 'Pi', product: /^(?:pi|pi-coding-agent|pi-agent|pi\.dev)$/i },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    product: /^(?:deepseek-harness|deepseek_harness)$/i
  },
  {
    id: 'cline',
    name: 'Cline',
    product: /^(?:cline|cline-cli|cline-sdk|cline-vscode|cline-desktop)$/i
  },
  { id: 'key', name: 'Key', product: /^key$/i },
  { id: 'opencode', name: 'OpenCode', product: /^opencode$/i },
  { id: 'cursor', name: 'Cursor', product: /^cursor$/i }
] as const

export type HarnessHeaders = Record<string, string | string[] | undefined>
export function harnessById(id: string) {
  return HARNESSES.find((h) => h.id === id)
}

/** Read product tokens, ignoring versions and comments (URLs / OS / other model names). */
export function harnessName(ua: string): string {
  if (ua.length > 4096 || /[\x00-\x1f\x7f]/.test(ua)) return '未知客户端'
  let products = ''
  let depth = 0
  let escaped = false
  for (const char of ua) {
    if (depth) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '(') depth++
      else if (char === ')') depth--
    } else if (char === '(') {
      depth = 1
      products += ' '
    } else products += char
  }
  // Compatibility with display-name UAs; never search arbitrary substrings.
  products = products
    .replace(/\b(Kimi|Claude)[ ]+Code(?=[/ ;]|$)/gi, '$1-Code')
    .replace(/\bDeepSeek[ ]+Harness(?=[/ ;]|$)/gi, 'DeepSeek-Harness')
  for (const token of products.trim().split(/[ ;]+/)) {
    const product = token.split('/')[0]
    const harness = HARNESSES.find((h) => h.product.test(product))
    if (harness) return harness.name
  }
  return '未知客户端'
}

/** Attribution only; these hints never affect authentication, routing or quotas. */
export function identifyHarness(headers: HarnessHeaders, explicitId?: string): string {
  const read = (key: string) => {
    const value = headers[key]
    return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
      ? value.trim()
      : ''
  }
  const explicit =
    harnessById(explicitId ?? '') ??
    harnessById(read('x-navo-harness').toLowerCase()) ??
    // Accept the legacy header for clients configured before the rename.
    harnessById(read('x-kimi-helper-harness').toLowerCase())
  if (explicit) return explicit.name
  // Kimi's host identity contract covers CLI, desktop and VS Code.
  // Only exact product platforms count; generic Moonshot/API headers do not.
  if (/^kimi_code_(?:cli|desktop|vscode)$/i.test(read('x-msh-platform'))) return 'Kimi Code'
  // Pi explicitly identifies its host even when a provider overrides its UA.
  if (read('x-opencode-client').toLowerCase() === 'pi') return 'Pi'
  if (/^cline(?:-sdk|-cli|-vscode|-desktop)?$/i.test(read('x-client-type'))) return 'Cline'
  if (read('originator').toLowerCase() === 'cline') return 'Cline'
  if (
    /^(?:codex_cli_rs|codex-tui|codex_vscode|codex_atlas|codex_chatgpt_desktop)$/i.test(
      read('originator')
    )
  )
    return 'Codex'
  return harnessName(read('user-agent'))
}

/** Briefly retain real transfer events so a 1.5s polling UI can show short requests. */
export function flowDirections(flows: LiveFlow[], now: number, enabled: boolean) {
  const recent = (time: number | null | undefined) =>
    time != null && now >= time && now - time < 2500
  return {
    upload: enabled && flows.some((f) => f.state !== 'error' && recent(f.lastUploadAt)),
    download: enabled && flows.some((f) => f.state !== 'error' && recent(f.lastActivityAt))
  }
}
