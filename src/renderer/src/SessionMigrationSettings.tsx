import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  ArrowRightLeft,
  Folder,
  FolderOpen,
  ScanLine,
  Check,
  MessageSquare,
  ChevronRight
} from 'lucide-react'
import type {
  MigrationProgress,
  MigrationPaths,
  MigrationScan,
  MigrationSession
} from '../../shared/session-migration'

function SelectionCheckbox({
  label,
  count,
  total,
  disabled,
  onChange
}: {
  label: string
  count: number
  total: number
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      aria-checked={count > 0 && count < total ? 'mixed' : count === total && total > 0}
      checked={total > 0 && count === total}
      ref={(input) => {
        if (input) input.indeterminate = count > 0 && count < total
      }}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}

function MigrationProgressView({ phase }: { phase: 'scan' | 'migrate' }) {
  const [progress, setProgress] = useState<MigrationProgress>()
  useEffect(() => window.navo.onMigrationProgress(setProgress), [])
  const determinate = !!progress?.total
  const percent = determinate
    ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
    : 0
  const title = phase === 'migrate' ? '正在迁移会话' : '正在扫描会话'
  return (
    <div className="migration-progress">
      <div className="migration-progress-heading">
        <span className="migration-progress-icon" aria-hidden="true">
          {phase === 'migrate' ? <ArrowRightLeft size={18} /> : <ScanLine size={18} />}
        </span>
        <div className="migration-progress-copy">
          <strong>{title}</strong>
          <span>
            {determinate ? (
              <>
                已处理 <b>{progress.completed.toLocaleString()}</b> /{' '}
                {progress.total.toLocaleString()} 个会话
              </>
            ) : (
              '正在读取会话信息…'
            )}
          </span>
        </div>
        <span className="migration-progress-percent" aria-hidden="true">
          {determinate ? (
            <>
              {percent}
              <small>%</small>
            </>
          ) : (
            <span className="migration-progress-pulse" />
          )}
        </span>
      </div>
      <div
        className={`migration-progress-track${determinate ? '' : ' is-indeterminate'}`}
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
        aria-valuetext={
          determinate
            ? `已处理 ${progress.completed} / ${progress.total} 个会话`
            : '正在读取会话信息'
        }
      >
        <span style={determinate ? { width: `${percent}%` } : undefined} />
      </div>
    </div>
  )
}

export function SessionMigrationSettings() {
  const [paths, setPaths] = useState<MigrationPaths>()
  const [scan, setScan] = useState<MigrationScan>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState<'scan' | 'migrate'>()
  const [status, setStatus] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const projects = useMemo(() => {
    const groups = new Map<string, MigrationSession[]>()
    for (const session of scan?.sessions ?? []) {
      const sessions = groups.get(session.workspace) ?? []
      sessions.push(session)
      groups.set(session.workspace, sessions)
    }
    return [...groups].map(([workspace, sessions]) => ({
      workspace,
      sessions,
      name: workspace.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || workspace
    }))
  }, [scan])
  function selectSessions(sessions: MigrationSession[], checked: boolean) {
    setSelected((old) => {
      const next = new Set(old)
      for (const session of sessions) {
        if (checked) next.add(session.key)
        else next.delete(session.key)
      }
      return next
    })
  }
  const pending = useRef(false)
  async function run(migrate: boolean) {
    if (pending.current) return
    setOperation(migrate ? 'migrate' : 'scan')
    pending.current = true
    setBusy(true)
    setErrors([])
    setWarnings([])
    setStatus('')
    try {
      if (migrate && scan) {
        const result = await window.navo.migrateZcodeSessions(
          scan.paths,
          scan.sessions
            .filter((s) => selected.has(s.key))
            .map(({ key, fingerprint }) => ({ key, fingerprint }))
        )
        setStatus(
          `已导入 ${result.imported} 个，已存在 ${result.skipped} 个，失败 ${result.errors.length} 个。重新打开 Kimi Code Desktop 查看。`
        )
        setErrors(result.errors)
        setWarnings(result.warnings)
        const completed = new Set(result.completedKeys)
        setScan({
          ...scan,
          sessions: scan.sessions.map((session) =>
            completed.has(session.key) ? { ...session, imported: true } : session
          )
        })
        setSelected((previous) => new Set([...previous].filter((key) => !completed.has(key))))
        return
      }
      const result = await window.navo.scanZcodeSessions(paths)
      setPaths(result.paths)
      setScan(result)
      setSelected(new Set())
      setErrors((current) => [...current, ...result.errors])
    } catch (e) {
      setErrors((current) => [...current, e instanceof Error ? e.message : '迁移失败'])
    } finally {
      pending.current = false
      setBusy(false)
      setOperation(undefined)
    }
  }
  async function chooseDirectory(key: keyof MigrationPaths) {
    if (!paths || pending.current) return
    pending.current = true
    setBusy(true)
    try {
      const path = await window.navo.chooseMigrationDirectory(paths[key])
      if (path !== null && path !== paths[key]) edit(key, path)
    } catch (e) {
      setErrors([e instanceof Error ? e.message : '无法打开文件夹选择器'])
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  function edit(key: keyof MigrationPaths, value: string) {
    setPaths((p) => (p ? { ...p, [key]: value } : p))
    setScan(undefined)
    setSelected(new Set())
    setStatus('')
  }
  return (
    <section className="lab-card migration-card" aria-label="Zcode 会话迁移" aria-busy={busy}>
      <header className="lab-card-heading">
        <span className="lab-icon migration-icon">
          <ArrowRightLeft size={20} />
        </span>
        <div className="lab-heading-copy">
          <h3>会话迁移</h3>
          <p>把 Zcode 中的对话带到 Kimi Code</p>
        </div>
        <span className="lab-badge">macOS</span>
      </header>
      <div className="migration-route">
        <span>
          <b>Z</b>Zcode
        </span>
        <ArrowRight size={18} />
        <span>
          <b>K</b>Kimi Code Desktop
        </span>
        <small>保留原始会话</small>
      </div>
      {paths && (
        <details className="migration-paths">
          <summary>
            <Folder size={14} />
            <span>数据目录</span>
            <ChevronRight size={14} />
          </summary>
          <div className="migration-path-fields">
            {(['source', 'target'] as const).map((key) => {
              const label = key === 'source' ? 'Zcode 数据目录' : 'Kimi Code 数据目录'
              return (
                <div className="migration-path-field" key={key}>
                  <label htmlFor={`migration-path-${key}`}>{label}</label>
                  <div className="migration-path-control">
                    <input
                      id={`migration-path-${key}`}
                      disabled={busy}
                      value={paths[key]}
                      onChange={(e) => edit(key, e.target.value)}
                    />
                    <button
                      type="button"
                      className="migration-folder-button"
                      aria-label={`选择${label}`}
                      title="选择文件夹"
                      disabled={busy}
                      onClick={() => void chooseDirectory(key)}
                    >
                      <FolderOpen size={16} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </details>
      )}
      <div className="migration-toolbar">
        <button className="button lab-secondary" disabled={busy} onClick={() => void run(false)}>
          <ScanLine size={15} />
          {busy ? '处理中…' : '扫描本机会话'}
        </button>
        <div className="migration-actions">
          {scan && (
            <>
              <button
                className="button lab-text-button"
                disabled={busy || !scan.sessions.length}
                onClick={() =>
                  setSelected(new Set(scan.sessions.filter((s) => !s.imported).map((s) => s.key)))
                }
              >
                选择未导入会话
              </button>
              <button
                className="button primary"
                disabled={busy || !selected.size}
                onClick={() => void run(true)}
              >
                迁移所选（{selected.size}）<ArrowRight size={14} />
              </button>
            </>
          )}
        </div>
      </div>
      {operation && <MigrationProgressView phase={operation} />}
      {scan?.coverage && (
        <p className="lab-footnote" role="status">
          {scan.coverage.sources.join(' + ')}
          {scan.coverage.indexed > 0 &&
            ` · 已匹配 ${scan.coverage.matched} / ${scan.coverage.indexed} 条索引任务`}
        </p>
      )}
      {status && (
        <p className="migration-result" role="status">
          {status}
        </p>
      )}
      {scan && scan.sessions.length > 0 && (
        <div className="migration-browser">
          <div className="migration-list-heading">
            <label className="migration-select-all">
              <SelectionCheckbox
                label="选择全部会话"
                count={selected.size}
                total={scan.sessions.length}
                disabled={busy}
                onChange={(checked) => selectSessions(scan.sessions, checked)}
              />
              <span>
                全选 <b>{scan.sessions.length}</b>
                <span className="migration-project-total"> · {projects.length} 个项目</span>
              </span>
            </label>
            <span>已选择 {selected.size} 个</span>
          </div>
          <div className="migration-list">
            {projects.map((project) => {
              const count = project.sessions.filter((session) => selected.has(session.key)).length
              const isCollapsed = collapsed.has(project.workspace)
              return (
                <section
                  className="migration-project"
                  key={project.workspace}
                  aria-label={`项目 ${project.workspace}`}
                >
                  <header className="migration-project-heading">
                    <SelectionCheckbox
                      label={`选择项目 ${project.workspace} 下的全部会话`}
                      count={count}
                      total={project.sessions.length}
                      disabled={busy}
                      onChange={(checked) => selectSessions(project.sessions, checked)}
                    />
                    <button
                      type="button"
                      className="migration-project-toggle"
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed((old) => {
                          const next = new Set(old)
                          if (next.has(project.workspace)) next.delete(project.workspace)
                          else next.add(project.workspace)
                          return next
                        })
                      }
                    >
                      <Folder size={15} />
                      <span className="migration-project-copy">
                        <strong>{project.name}</strong>
                        <small title={project.workspace}>{project.workspace}</small>
                      </span>
                      <span className="migration-project-count">
                        {count > 0 ? `${count} / ` : ''}
                        {project.sessions.length}
                      </span>
                      <ChevronRight size={14} className={isCollapsed ? '' : 'is-open'} />
                    </button>
                  </header>
                  <div hidden={isCollapsed}>
                    {project.sessions.map((session) => (
                      <div
                        className={`migration-row ${selected.has(session.key) ? 'is-selected' : ''}`}
                        key={session.key}
                      >
                        <label className="migration-session">
                          <input
                            type="checkbox"
                            aria-label={`选择会话 ${session.title}`}
                            disabled={busy}
                            checked={selected.has(session.key)}
                            onChange={(e) =>
                              setSelected((old) => {
                                const next = new Set(old)
                                if (e.target.checked) next.add(session.key)
                                else next.delete(session.key)
                                return next
                              })
                            }
                          />
                          <span className="migration-session-copy">
                            <span className="migration-session-title">
                              <strong>{session.title}</strong>
                              {session.imported ? (
                                <span className="migration-tag">
                                  <Check size={11} />
                                  已导入
                                </span>
                              ) : session.legacyImported ? (
                                <span className="migration-tag">可重新迁移</span>
                              ) : null}
                            </span>
                            <span className="migration-meta">
                              <span>
                                <MessageSquare size={11} />
                                {session.messageCount} 条消息
                              </span>
                              <span>{session.counts.tools} 次工具调用</span>
                              {session.counts.subagents > 0 && (
                                <span>{session.counts.subagents} 个子代理</span>
                              )}
                              {session.counts.attachments > 0 && (
                                <span>{session.counts.attachments} 个附件</span>
                              )}
                              {session.updatedAt > 0 && (
                                <time>{new Date(session.updatedAt).toLocaleDateString()}</time>
                              )}
                            </span>
                          </span>
                        </label>
                        {session.warnings.length > 0 && (
                          <details className="migration-row-notes">
                            <summary>迁移说明 · {session.warnings.length}</summary>
                            {session.warnings.map((warning) => (
                              <p key={warning}>{warning}</p>
                            ))}
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      )}
      {scan && !scan.sessions.length && !errors.length && (
        <div className="migration-empty">
          <MessageSquare size={22} />
          <span>暂无可迁移的会话</span>
        </div>
      )}
      <p className="lab-footnote">迁移前请结束源会话，并退出 Kimi Code Desktop</p>
      {warnings.length > 0 && (
        <details className="migration-notes">
          <summary>查看迁移说明（{warnings.length}）</summary>
          {warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
        </details>
      )}
      {errors.length > 0 && (
        <div role="alert" className="error-banner migration-errors">
          {errors.map((error, i) => (
            <p key={i}>{error}</p>
          ))}
        </div>
      )}
    </section>
  )
}
