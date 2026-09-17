import { createHash, randomUUID } from 'node:crypto'
import { FLOW_IDLE_RETENTION_MS, identifyHarness, type LiveFlow } from '../../shared/live-flow'
import type { TokenUsage } from '../../shared/usage'

/** Ephemeral telemetry: no prompts, credentials or raw client identifiers retained. */
export class LiveFlowTracker {
  private flows = new Map<string, LiveFlow>()
  constructor(
    private readonly now: () => number = Date.now,
    private readonly retentionMs: () => number = () => FLOW_IDLE_RETENTION_MS
  ) {}

  start(
    headers: Record<string, string | string[] | undefined>,
    session: string,
    model: string,
    harnessId?: string
  ): string {
    this.prune()
    const id = randomUUID()
    const harness = identifyHarness(headers, harnessId)
    // One display node per Harness + sticky session, including all child agents,
    // concurrent requests and models. Requests without a session stay separate.
    const identity = session ? 'session' : 'request'
    const agentKey = createHash('sha256')
      .update(JSON.stringify([harness, identity, session || id]))
      .digest('hex')
    const now = this.now()
    this.flows.set(id, {
      id,
      harness,
      agentKey,
      identity,
      model,
      startedAt: now,
      updatedAt: now,
      lastActivityAt: null,
      lastUploadAt: null,
      uploadBytes: 0,
      endedAt: null,
      state: 'waiting',
      bytes: 0,
      usage: null
    })
    return id
  }
  update(id: string, patch: Partial<Pick<LiveFlow, 'state' | 'usage'>>): void {
    const flow = this.flows.get(id)
    if (flow) Object.assign(flow, patch, { updatedAt: this.now() })
  }
  upload(id: string, bytes: number): void {
    const flow = this.flows.get(id)
    if (flow && flow.endedAt === null && bytes > 0)
      Object.assign(flow, {
        uploadBytes: (flow.uploadBytes ?? 0) + bytes,
        lastUploadAt: this.now(),
        updatedAt: this.now()
      })
  }
  activity(id: string, bytes: number): void {
    const flow = this.flows.get(id)
    if (flow)
      Object.assign(flow, {
        state: 'streaming',
        bytes: flow.bytes + bytes,
        lastActivityAt: this.now(),
        updatedAt: this.now()
      })
  }
  finish(id: string, success: boolean, usage: TokenUsage | null): void {
    const flow = this.flows.get(id)
    if (flow)
      Object.assign(flow, {
        state: success ? 'completed' : 'error',
        usage,
        endedAt: this.now(),
        updatedAt: this.now()
      })
    this.prune()
  }
  snapshot(): LiveFlow[] {
    this.prune()
    return structuredClone([...this.flows.values()])
  }
  private prune(): void {
    const ended = [...this.flows.values()]
      .filter((f) => f.endedAt !== null)
      .sort((a, b) => b.endedAt! - a.endedAt!)
    const activeAgents = new Set(
      [...this.flows.values()].filter((f) => f.endedAt === null).map((f) => f.agentKey)
    )
    const seen = new Set<string>()
    const now = this.now()
    const retention = this.retentionMs()
    ended.forEach((flow, index) => {
      const latestForAgent = !seen.has(flow.agentKey)
      seen.add(flow.agentKey)
      // Preserve one record per node for the configured idle interval after its last request
      // finishes. The detail cap must not remove idle nodes prematurely.
      const keepNode =
        latestForAgent && (activeAgents.has(flow.agentKey) || now - flow.endedAt! < retention)
      if (!keepNode && (now - flow.endedAt! >= retention || index >= 200))
        this.flows.delete(flow.id)
    })
  }
}
