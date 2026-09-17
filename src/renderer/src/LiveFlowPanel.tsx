import { useEffect, useRef, useState, useId, type CSSProperties } from 'react'
import { Activity, Radio } from 'lucide-react'
import { FLOW_IDLE_MINUTES, flowDirections, type LiveFlow } from '../../shared/live-flow'
import { orderLiveFlows, type FlowOrder } from '../../shared/flow-order'
import './live-flow.css'
import botIcon from './assets/bot.svg?raw'
import botOffIcon from './assets/bot-off.svg?raw'
import { HarnessLogo } from './HarnessLogo'
import { ModelLogo } from './ModelLogo'

const number = (value: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
const labels = {
  waiting: '等待响应',
  streaming: '正在传输',
  completed: '已完成',
  error: '失败 / 中断'
}
const active = (f: LiveFlow) => f.endedAt === null

export function LiveFlowPanel({
  flows,
  running,
  stale,
  idleMinutes = 5,
  idleDisabled = false,
  onIdleMinutesChange
}: {
  flows: LiveFlow[]
  running: boolean
  stale: boolean
  idleMinutes?: number
  idleDisabled?: boolean
  onIdleMinutesChange?: (minutes: number) => Promise<boolean>
}) {
  const markerId = useId().replace(/:/g, '')
  const viewport = useRef<HTMLDivElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 935, height: 500 })
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setViewportSize({ width: element.clientWidth - 40, height: element.clientHeight - 24 })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [now, setNow] = useState(Date.now)
  const flowOrder = useRef<FlowOrder>(new Map())
  flows = orderLiveFlows(flows, flowOrder.current)
  const identities = useRef(new Map<string, number>())
  const counters = useRef(new Map<string, number>())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])
  const harnesses = [...new Set(flows.map((f) => f.harness))]
  const agentCount = new Set(flows.map((f) => f.agentKey)).size
  const inFlight = flows.filter(active).length
  let row = 0
  const groups = harnesses.map((harness, groupIndex) => {
    const requests = flows.filter((f) => f.harness === harness)
    const start = row
    const agents = [...new Set(requests.map((f) => f.agentKey))].map((key) => {
      const calls = requests.filter((f) => f.agentKey === key)
      if (!identities.current.has(key)) {
        const next = (counters.current.get(harness) ?? 0) + 1
        counters.current.set(harness, next)
        identities.current.set(key, next)
      }
      const from = row
      const routes = [...new Set(calls.map((f) => f.model))].map((model) => {
        const items = calls.filter((f) => f.model === model)
        const latest = items.at(-1)!
        const busy = items.some(active)
        const direction = flowDirections(items, now, !stale && running)
        const moving = direction.upload || direction.download
        const y = 64 + row++ * 96
        return {
          model,
          items,
          busy,
          moving,
          direction,
          y,
          state: busy ? (direction.download ? 'streaming' : 'waiting') : latest.state
        }
      })
      return {
        key,
        calls,
        routes,
        y: 64 + (from + row - 1) * 48,
        label: `调用 ${identities.current.get(key)}`
      }
    })
    const end = row
    row += 0.45
    return {
      harness,
      requests,
      agents,
      groupIndex,
      bottom: 64 + (end - 1) * 96 + 64,
      y: 64 + (start + end - 1) * 48
    }
  })
  // Keep nodes between 65% and 100%; overflow vertically once the minimum is reached.
  const bounds = groups.flatMap((g) => [
    [g.y - 45, g.y + 51],
    ...g.agents.flatMap((a) => [[a.y - 31, a.y + 37], ...a.routes.map((r) => [r.y - 39, r.y + 45])])
  ])
  const top = bounds.length ? Math.min(...bounds.map((b) => b[0])) - 18 : 0
  const bottom = bounds.length ? Math.max(...bounds.map((b) => b[1])) + 18 : 220
  const scale = Math.min(
    1,
    viewportSize.width / 935,
    Math.max(0.65, viewportSize.height / (bottom - top))
  )
  const edge = (
    key: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    direction: { upload: boolean; download: boolean }
  ) => (
    <g key={key}>
      {(['upload', 'download'] as const).map((kind) => {
        const lane = kind === 'upload' ? -9 : 9
        const path = `M ${x1} ${y1 + lane} C ${(x1 + x2) / 2} ${y1 + lane}, ${(x1 + x2) / 2} ${y2 + lane}, ${x2} ${y2 + lane}`
        const moving = direction[kind]
        return (
          <g key={kind} className={`flow-link flow-${kind} ${moving ? 'is-live' : ''}`}>
            <title>
              {kind === 'upload' ? '上传：Harness → Agent → 模型' : '下传：模型 → Agent → Harness'}
            </title>
            <path d={path} className="flow-wire-halo" />
            <path
              d={path}
              className="flow-wire"
              markerEnd={kind === 'upload' ? `url(#${markerId}-up)` : undefined}
              markerStart={kind === 'download' ? `url(#${markerId}-down)` : undefined}
            />
            {moving && (
              <>
                <path d={path} className="flow-beam" />
                <path d={path} className="flow-particles" />
              </>
            )}
          </g>
        )
      })}
    </g>
  )
  return (
    <section className="live-flow-panel" aria-label="实时 Agent 调用与 Token 流转">
      <header className="flow-heading">
        <span className="flow-eyebrow">
          <Radio size={13} /> LIVE GATEWAY TELEMETRY
        </span>
        <FlowIdleSlider
          minutes={idleMinutes}
          disabled={idleDisabled}
          onSave={onIdleMinutesChange}
        />
        <span className={`flow-status ${running && !stale ? 'online' : ''}`}>
          <i />
          {stale ? 'CONNECTION LOST' : running ? 'GATEWAY ONLINE' : 'GATEWAY OFFLINE'}
        </span>
      </header>
      <div className="flow-canvas-scroll" ref={viewport}>
        <div className="flow-canvas">
          {!flows.length ? (
            <div className="flow-empty">
              <div className="flow-radar">
                <Activity size={36} />
              </div>
              <h3>{running ? '等待第一条调用' : '启动网关，观察调用流转'}</h3>
              <p>客户端发起模型请求后，真实的 Harness、Agent 和模型会自动出现在这里。</p>
            </div>
          ) : (
            <svg
              className="flow-graph"
              style={{ width: 935 * scale, height: (bottom - top) * scale }}
              viewBox={`70 ${top} 935 ${bottom - top}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={`${harnesses.length} 个客户端，${agentCount} 个 Agent 或会话，${inFlight} 个进行中请求`}
            >
              <defs>
                <marker
                  id={`${markerId}-up`}
                  viewBox="0 0 8 8"
                  refX="8"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M0 0 L8 4 L0 8 Z" fill="var(--flow-upload-color)" />
                </marker>
                <marker
                  id={`${markerId}-down`}
                  viewBox="0 0 8 8"
                  refX="0"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M8 0 L0 4 L8 8 Z" fill="var(--flow-download-color)" />
                </marker>
              </defs>
              {groups.slice(0, -1).map((g) => (
                <line
                  key={g.harness}
                  x1="18"
                  x2="985"
                  y1={g.bottom}
                  y2={g.bottom}
                  className="flow-group-divider"
                />
              ))}
              {groups.flatMap((g) =>
                g.agents.flatMap((a) => [
                  edge(`${a.key}-in`, 186, g.y, 460, a.y, {
                    upload: a.routes.some((r) => r.direction.upload),
                    download: a.routes.some((r) => r.direction.download)
                  }),
                  ...a.routes.map((r) =>
                    edge(`${a.key}-${r.model}`, 548, a.y, 760, r.y, r.direction)
                  )
                ])
              )}
              {groups.map((g) => (
                <g
                  key={g.harness}
                  style={
                    {
                      '--group-color':
                        g.groupIndex % 2 ? 'var(--flow-group-purple)' : 'var(--flow-group-cyan)'
                    } as CSSProperties
                  }
                >
                  <foreignObject x="90" y={g.y - 45} width="96" height="96">
                    <div
                      className={`flow-node harness ${g.agents.some((a) => a.routes.some((r) => r.moving)) ? 'transmitting' : ''}`}
                    >
                      <span className="flow-monogram">
                        <HarnessLogo name={g.harness} />
                      </span>
                    </div>
                  </foreignObject>
                  {g.agents.map((a) => (
                    <g key={a.key}>
                      <foreignObject x="460" y={a.y - 31} width="88" height="68">
                        <div
                          className={`flow-node agent ${a.routes.some((r) => r.busy) ? 'busy' : ''}`}
                          role="img"
                          aria-label={`${a.label}，${a.calls.filter(active).length} 个并发请求`}
                        >
                          <span
                            className="flow-core"
                            title={
                              a.routes.some((r) => r.busy)
                                ? '请求进行中'
                                : `空闲，保留 ${idleMinutes} 分钟后移除`
                            }
                          >
                            <span
                              className="flow-bot-icon"
                              data-state={a.routes.some((r) => r.busy) ? 'active' : 'idle'}
                              aria-hidden="true"
                              dangerouslySetInnerHTML={{
                                __html: a.routes.some((r) => r.busy) ? botIcon : botOffIcon
                              }}
                            />
                          </span>
                        </div>
                      </foreignObject>
                      {a.routes.map((r) => (
                        <foreignObject key={r.model} x="760" y={r.y - 39} width="225" height="84">
                          <div
                            className={`flow-node model ${r.state}`}
                            title={`${r.model} · ${stale ? '状态待同步' : r.direction.upload && r.direction.download ? '上传 · 下传' : r.direction.upload ? '上传中' : r.direction.download ? '下传中' : labels[r.state as keyof typeof labels]}`}
                          >
                            <span className="flow-model-brand">
                              <ModelLogo model={r.model} />
                            </span>
                            <strong>{r.model}</strong>
                            <span className="flow-token-count">
                              ↑{' '}
                              {r.items.some((f) => f.usage?.input != null)
                                ? number(r.items.reduce((s, f) => s + (f.usage?.input ?? 0), 0))
                                : '—'}{' '}
                              <span>输入</span>　↓{' '}
                              {r.items.some((f) => f.usage?.output != null)
                                ? number(r.items.reduce((s, f) => s + (f.usage?.output ?? 0), 0))
                                : '—'}{' '}
                              <span>输出</span>
                            </span>
                          </div>
                        </foreignObject>
                      ))}
                    </g>
                  ))}
                </g>
              ))}
            </svg>
          )}
        </div>
      </div>
    </section>
  )
}

function FlowIdleSlider({
  minutes,
  disabled,
  onSave
}: {
  minutes: number
  disabled: boolean
  onSave?: (minutes: number) => Promise<boolean>
}) {
  const indexOf = (value: number) =>
    Math.max(
      0,
      FLOW_IDLE_MINUTES.findIndex((m) => m === value)
    )
  const [index, setIndex] = useState(() => indexOf(minutes))
  const saving = useRef(false)
  useEffect(() => setIndex(indexOf(minutes)), [minutes])
  const commit = async (value: number) => {
    if (saving.current || disabled || !onSave || FLOW_IDLE_MINUTES[value] === minutes) return
    saving.current = true
    try {
      if (!(await onSave(FLOW_IDLE_MINUTES[value]))) setIndex(indexOf(minutes))
    } catch {
      setIndex(indexOf(minutes))
    } finally {
      saving.current = false
    }
  }
  return (
    <label className="flow-idle-control">
      <span>
        等待 <strong>{FLOW_IDLE_MINUTES[index]}</strong> 分钟
      </span>
      <span className="flow-idle-track">
        <input
          type="range"
          min={0}
          max={4}
          step={1}
          value={index}
          disabled={disabled || !onSave}
          aria-label="空闲节点保留时间"
          aria-valuetext={`${FLOW_IDLE_MINUTES[index]} 分钟`}
          onChange={(event) => setIndex(event.currentTarget.valueAsNumber)}
          onPointerUp={(event) => void commit(event.currentTarget.valueAsNumber)}
          onKeyUp={(event) => void commit(event.currentTarget.valueAsNumber)}
          onBlur={(event) => void commit(event.currentTarget.valueAsNumber)}
          onPointerCancel={() => setIndex(indexOf(minutes))}
        />
        <span className="flow-idle-ticks" aria-hidden="true">
          {FLOW_IDLE_MINUTES.map((value) => (
            <span key={value}>{value}</span>
          ))}
        </span>
      </span>
    </label>
  )
}
