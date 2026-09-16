import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayStore, validateModelProtocols } from '../src/main/services/gateway-store'
import { modelUpstreamRoute, supportedModelProtocols } from '../src/shared/model-protocols'

test('model protocol defaults, direct preference, deterministic conversion and validation', () => {
  assert.deepEqual(supportedModelProtocols({ provider: 'opencode-go' }, 'minimax-test'), [
    'messages'
  ])
  assert.equal(supportedModelProtocols({ provider: 'kimi' }, 'kimi-for-coding').length, 3)
  const modelProtocols = validateModelProtocols({ 'gpt-test': ['messages', 'responses'] })
  const account = { provider: 'opencode-go' as const, modelProtocols }
  assert.equal(modelUpstreamRoute(account, 'gpt-test', '/v1/messages'), '/v1/messages')
  assert.equal(modelUpstreamRoute(account, 'gpt-test', '/v1/chat/completions'), '/v1/responses')
  assert.equal(
    modelUpstreamRoute(account, 'gpt-test', '/v1/messages/count_tokens'),
    '/v1/messages/count_tokens'
  )
  assert.equal(
    modelUpstreamRoute({ modelProtocols: { model: ['responses'] } }, 'model', '/v1/messages'),
    '/v1/responses'
  )
  for (const value of [null, [], { m: [] }, { m: ['invalid'] }, { m: ['messages', 'messages'] }])
    assert.throws(() => validateModelProtocols(value))
  assert.deepEqual(supportedModelProtocols({ modelProtocols: {} }, 'constructor'), [
    'messages',
    'responses',
    'chat-completions'
  ])
})

test('manual model protocols persist, survive metadata updates, and can reset to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-protocol-test-'))
  const codec = { encrypt: (v: string) => v, decrypt: (v: string) => v }
  const file = join(dir, 'store.json')
  const store = new GatewayStore(file, codec)
  try {
    const input = {
      name: 'go',
      kind: 'api-key' as const,
      provider: 'opencode-go' as const,
      region: 'global' as const,
      enabled: true,
      memberships: [{ groupId: 'default', priority: 0, weight: 1 }],
      secret: 'test-key',
      modelProtocols: validateModelProtocols({ 'minimax-test': ['responses'] })
    }
    const capabilities = {
      models: ['minimax-test'],
      maxConcurrency: null,
      checkedAt: Date.now(),
      warning: '',
      quota: null
    }
    const id = await store.saveAccount(input, capabilities)
    const { modelProtocols: _overrides, secret: _secret, ...update } = input
    await store.saveAccount(
      { ...update, id },
      { ...capabilities, models: ['minimax-test', 'new-model'] }
    )
    const restored = new GatewayStore(file, codec)
    await restored.load()
    assert.deepEqual(restored.get().accounts[0].modelProtocols, input.modelProtocols)
    assert.deepEqual(supportedModelProtocols(restored.get().accounts[0], 'new-model'), [
      'chat-completions'
    ])
    await restored.saveAccount({ ...update, id, modelProtocols: {} })
    assert.deepEqual(supportedModelProtocols(restored.get().accounts[0], 'minimax-test'), [
      'messages'
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
