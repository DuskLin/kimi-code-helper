import { useEffect, useState } from 'react'
import { heatmapLevel, localDayKey, type UsageStats } from '../../shared/usage'

const tokens = (value: number | null) => (value == null ? '未知' : value.toLocaleString('zh-CN'))
const cost = (value: number | null) => (value == null ? '未知' : `$${value.toFixed(4)}`)

export function UsageHeatmap({ data }: { data: UsageStats | undefined }) {
  const [selected, setSelected] = useState<number>()
  const [detail, setDetail] = useState<UsageStats>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (selected === undefined) return
    let active = true
    setError('')
    const end = new Date(selected)
    end.setDate(end.getDate() + 1)
    void window.kimiHelper
      .getUsageStats({ start: selected, end: end.getTime(), bucketMs: 3600000 })
      .then((result) => {
        if (active) setDetail(result)
      })
      .catch(() => {
        if (active) setError('当日明细读取失败，请重新选择日期')
      })
    return () => {
      active = false
    }
  }, [selected, data])
  const days = data?.points ?? []
  const offset = days.length ? (new Date(days[0].time).getDay() + 6) % 7 : 0
  const maximum = Math.max(1, ...days.map((day) => day.totalTokens ?? 0))
  const today = localDayKey(Date.now())
  const months = new Map<number, string>()
  days.forEach((day, index) => {
    const date = new Date(day.time)
    if (index === 0 || date.getDate() === 1)
      months.set(Math.floor((index + offset) / 7) + 2, `${date.getMonth() + 1}月`)
  })
  return (
    <section className="usage-heatmap" aria-label="每日消耗热力图">
      <div className="usage-trend-heading">
        <h3>每日消耗热力图</h3>
        <small>近 112 天 · 悬停看明细</small>
      </div>
      <div className="heatmap-scroll">
        <div
          className="heatmap-grid"
          style={{
            gridTemplateColumns: `34px repeat(${Math.ceil((days.length + offset) / 7)}, 14px)`
          }}
        >
          {[
            ['周一', 2],
            ['周三', 4],
            ['周五', 6],
            ['周日', 8]
          ].map(([name, row]) => (
            <span
              className="heatmap-day-label"
              key={name}
              style={{ gridColumn: 1, gridRow: Number(row) }}
            >
              {name}
            </span>
          ))}
          {[...months].map(([column, label]) => (
            <span className="heatmap-month" key={column} style={{ gridColumn: column, gridRow: 1 }}>
              {label}
            </span>
          ))}
          {days.map((day, index) => {
            const key = localDayKey(day.time)
            const col = Math.floor((index + offset) / 7) + 2,
              row = ((index + offset) % 7) + 2
            const unknown = day.requests > 0 && day.totalTokens === null
            const title = `${key}\n${day.requests} 次请求 · ${tokens(day.totalTokens ?? (day.requests === 0 ? 0 : null))} tokens\n已报告用量 ${day.reported}/${day.requests} · 成本 ${cost(day.cost)}\n中断 ${day.interruptedRequests} 次`
            return (
              <div className="heatmap-day-wrapper" key={key}>
                <button
                  className={`heatmap-day heatmap-level-${heatmapLevel(day.totalTokens, maximum)} ${unknown ? 'is-unknown' : ''} ${key === today ? 'is-today' : ''}`}
                  style={{ gridColumn: col, gridRow: row }}
                  title={title}
                  aria-label={title.replace(/\n/g, '，')}
                  aria-pressed={selected === day.time}
                  onClick={() => {
                    setDetail(undefined)
                    setSelected((value) => (value === day.time ? undefined : day.time))
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>
      {!data && <p className="muted">正在加载消耗记录…</p>}
      <div className="heatmap-legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <i key={level} className={`heatmap-level-${level}`} />
        ))}
        <span>多</span>
        <i className="is-unknown" />
        <span>用量未知</span>
      </div>
      <div className="heatmap-detail">
        {selected === undefined ? (
          <small>点击日期查看当日明细</small>
        ) : (
          <>
            <div className="usage-trend-heading">
              <strong>{localDayKey(selected)} 明细</strong>
              <button className="text-button" onClick={() => setSelected(undefined)}>
                收起
              </button>
            </div>
            {error ? (
              <p role="alert" className="form-error">
                {error}
              </p>
            ) : !detail ? (
              <p className="muted">正在加载…</p>
            ) : (
              <>
                <p className="heatmap-day-summary">
                  {detail.summary.requests} 次请求 ·{' '}
                  {tokens(detail.summary.totalTokens ?? (detail.summary.requests === 0 ? 0 : null))}{' '}
                  tokens · 成本 {cost(detail.summary.cost)} · 中断{' '}
                  {detail.summary.interruptedRequests} 次
                </p>
                {detail.byModel.length > 0 && (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>模型</th>
                          <th>请求数</th>
                          <th>Tokens</th>
                          <th>平均生成速度</th>
                          <th>中断请求</th>
                          <th>成本</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.byModel.map((model) => (
                          <tr key={model.model}>
                            <td>{model.model}</td>
                            <td>{model.requests}</td>
                            <td>{tokens(model.totalTokens)}</td>
                            <td>
                              {model.averageTokensPerSecond == null
                                ? '—'
                                : `${model.averageTokensPerSecond.toFixed(1)} tokens/s`}
                            </td>
                            <td>{model.interruptedRequests}</td>
                            <td>{cost(model.cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}
