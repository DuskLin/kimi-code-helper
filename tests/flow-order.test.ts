import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderLiveFlows, type FlowOrder } from '../src/shared/flow-order'
import { LiveFlowTracker } from '../src/main/services/live-flow'
import { requestSessionId } from '../src/shared/request-session'

test('pruning old requests does not swap sessions or model rows', () => {
  const tracker = new LiveFlowTracker()
  tracker.start({}, 'first', 'k3')
  tracker.start({}, 'first', 'deepseek')
  tracker.start({}, 'second', 'deepseek')
  tracker.start({}, 'second', 'k3')
  const initial = tracker.snapshot()
  const order: FlowOrder = new Map()
  orderLiveFlows(initial, order)
  const next = [
    initial[3],
    initial[2],
    initial[1],
    { ...initial[0], id: 'new', startedAt: Date.now() + 100 }
  ]
  const result = orderLiveFlows(next, order)
  assert.deepEqual(
    result.map((f) => [f.agentKey, f.model]),
    initial.map((f) => [f.agentKey, f.model])
  )
  assert.equal(next[0], initial[3], 'does not mutate the snapshot')
  orderLiveFlows([], order)
  assert.equal(order.size, 0)
})

test('explicit conversation stays on one node when cache keys rotate', () => {
  const tracker = new LiveFlowTracker()
  for (const cache of ['a', 'b', 'a']) {
    const headers = { 'session-id': 'conversation', 'user-agent': 'kimi-code-desktop/1' }
    const payload = { prompt_cache_key: cache }
    tracker.start(headers, requestSessionId(headers, payload) ?? cache, 'deepseek')
  }
  tracker.start({}, 'different-conversation', 'deepseek')
  const flows = tracker.snapshot()
  assert.equal(new Set(flows.slice(0, 3).map((f) => f.agentKey)).size, 1)
  assert.notEqual(flows[0].agentKey, flows[3].agentKey)
})
