import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestSessionId } from '../src/shared/request-session'

test('extract explicit session identifiers without merging by user or cache key', () => {
  assert.equal(requestSessionId({ 'x-session-id': 'conversation' }, {}), 'conversation')
  assert.equal(requestSessionId({ 'x-opencode-session': 'go-session' }, {}), 'go-session')
  assert.equal(
    requestSessionId(
      {},
      { metadata: { user_id: JSON.stringify({ session_id: 'claude-session' }) } }
    ),
    'claude-session'
  )
  const uuid = '01234567-89ab-cdef-0123-456789abcdef'
  assert.equal(
    requestSessionId({}, { metadata: { user_id: `user_a_account_b_session_${uuid}` } }),
    uuid
  )
  assert.equal(
    requestSessionId({}, { prompt_cache_key: 'shared', metadata: { user_id: 'user-a' } }),
    undefined
  )
  assert.equal(requestSessionId({ 'x-session-id': 'x'.repeat(513) }, {}), undefined)
})

test('Kimi Code transports its session ID in protocol-specific cache fields', () => {
  for (const platform of ['desktop', 'cli', 'vscode']) {
    for (const headers of [
      { 'x-msh-platform': `kimi_code_${platform}` },
      { 'user-agent': `kimi-code-${platform}/1.0.1` }
    ]) {
      for (const payload of [
        { prompt_cache_key: 'session-1' },
        { metadata: { user_id: 'session-1' } }
      ]) {
        assert.equal(requestSessionId(headers, payload), 'session-1')
        assert.equal(
          requestSessionId({ ...headers, 'x-session-id': 'explicit' }, payload),
          'explicit'
        )
      }
    }
  }
  const headers = { 'x-msh-platform': 'kimi_code_desktop' }
  for (const value of ['', ' ', 'x'.repeat(513), 'bad\r\nvalue', 123, ['session']]) {
    assert.equal(requestSessionId(headers, { prompt_cache_key: value }), undefined)
    assert.equal(requestSessionId(headers, { metadata: { user_id: value } }), undefined)
  }
  for (const headers of [{}, { 'x-msh-platform': 'kimi_code_desktop_proxy' }]) {
    assert.equal(requestSessionId(headers, { prompt_cache_key: 'shared' }), undefined)
    assert.equal(requestSessionId(headers, { metadata: { user_id: 'user-a' } }), undefined)
  }
})
