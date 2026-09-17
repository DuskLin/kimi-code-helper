import type { LiveFlow } from './live-flow'

export type FlowOrder = Map<string, number>

/** Preserve first-seen topology order even when older request records are pruned. */
export function orderLiveFlows(flows: LiveFlow[], order: FlowOrder): LiveFlow[] {
  const keys = (flow: LiveFlow) => [
    JSON.stringify([flow.harness]),
    JSON.stringify([flow.harness, flow.agentKey]),
    JSON.stringify([flow.harness, flow.agentKey, flow.model])
  ]
  const present = new Set<string>()
  let next = 0
  for (const rank of order.values()) next = Math.max(next, rank + 1)
  for (const flow of flows) {
    for (const key of keys(flow)) {
      present.add(key)
      if (!order.has(key)) order.set(key, next++)
    }
  }
  // Forget expired nodes, but retain the rank of every node still on screen.
  for (const key of order.keys()) if (!present.has(key)) order.delete(key)
  return [...flows].sort((a, b) => {
    const left = keys(a)
    const right = keys(b)
    for (let i = 0; i < left.length; i++) {
      const difference = order.get(left[i])! - order.get(right[i])!
      if (difference) return difference
    }
    return a.startedAt - b.startedAt
  })
}
