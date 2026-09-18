import { parentPort, workerData } from 'node:worker_threads'
import { RequestHistory } from './request-history'
import type { UsageQuery, UsageStats } from '../../shared/usage'
import type { RequestPricing } from '../../shared/request-cost'

const history = new RequestHistory(workerData.file, true)
const cache = new Map<string, { version: number; at: number; result: UsageStats }>()
parentPort!.on(
  'message',
  ({ id, query, pricing }: { id: number; query: UsageQuery; pricing?: RequestPricing }) => {
    try {
      const key = JSON.stringify([query, pricing])
      const version = history.dataVersion
      const cached = cache.get(key)
      if (cached && cached.version === version && Date.now() - cached.at < 5000) {
        parentPort!.postMessage({ id, result: cached.result })
        return
      }
      const result = history.usageSnapshot(query, pricing)
      if (cache.size >= 8) cache.delete(cache.keys().next().value!)
      cache.set(key, { version, at: Date.now(), result })
      parentPort!.postMessage({ id, result })
    } catch (error) {
      parentPort!.postMessage({
        id,
        error: error instanceof Error ? error.message : '统计读取失败'
      })
    }
  }
)
