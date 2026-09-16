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
