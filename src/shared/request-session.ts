import { identifyHarness } from './live-flow'

/** Explicit conversation IDs and client-specific fields with known session semantics. */
export function requestSessionId(
  headers: Record<string, string | string[] | undefined>,
  payload: Record<string, unknown>
): string | undefined {
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? (payload.metadata as Record<string, unknown>)
      : {}
  let encoded: unknown
  if (typeof metadata.user_id === 'string') {
    try {
      encoded = (JSON.parse(metadata.user_id) as { session_id?: unknown } | null)?.session_id
    } catch {
      encoded = metadata.user_id.match(
        /_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
      )?.[1]
    }
  }
  // Kimi Code's resolveRequestParams uses sessionContext.sessionId as cacheKey.
  // OpenAI/Kimi encode it as prompt_cache_key; Anthropic uses metadata.user_id.
  // Do not apply those semantics to arbitrary clients' cache keys or user IDs.
  const kimiCode = identifyHarness(headers) === 'Kimi Code'
  for (const value of [
    headers['x-session-id'],
    headers['x-opencode-session'],
    headers['session-id'],
    headers.session_id,
    headers.conversation_id,
    headers['x-conversation-id'],
    headers['x-claude-code-session-id'],
    payload.session_id,
    payload.conversation_id,
    metadata.session_id,
    encoded,
    ...(kimiCode ? [payload.prompt_cache_key, metadata.user_id] : [])
  ]) {
    if (
      typeof value === 'string' &&
      value.trim() &&
      value.length <= 512 &&
      !/[\x00-\x1f\x7f]/.test(value)
    )
      return value.trim()
  }
  return undefined
}
