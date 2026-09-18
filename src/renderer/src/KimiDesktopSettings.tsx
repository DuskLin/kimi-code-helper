import { useEffect, useRef, useState } from 'react'
import { SettingsToggle } from './SettingsToggle'
import type { KimiDesktopState, KimiDesktopPreferences } from '../../shared/kimi-desktop'

export function KimiDesktopSettings() {
  const [state, setState] = useState<KimiDesktopState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  useEffect(() => {
    let alive = true
    const poll = async () => {
      if (pending.current) return
      try {
        const result = await window.navo.getKimiDesktop()
        if (alive && !pending.current) setState(result)
      } catch {
        if (alive) setError('无法读取桌面集成状态')
      }
    }
    void poll()
    const timer = setInterval(poll, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  async function action(run: () => Promise<KimiDesktopState>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      setState(await run())
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const save = (patch: Partial<KimiDesktopPreferences>) => {
    if (!state) return
    void action(() =>
      window.navo.saveKimiDesktop({
        enabled: state.enabled,
        autoReapply: state.autoReapply,
        ...patch
      })
    )
  }
  return (
    <>
      <h2 className="experimental-heading">
        Kimi Code Desktop <span className="experimental-badge">实验性功能</span>
      </h2>
      <p className="settings-description">在 Desktop 顶部显示账号额度与会话统计。</p>
      <div className="experimental-notice" role="note">
        非官方集成，可能随 Kimi Code 更新随时失效。
      </div>
      {state ? (
        <>
          <div className="card-display-options">
            <SettingsToggle
              label="启用集成"
              hint="需保持 Navo 运行，关闭后移除补丁。"
              checked={state.enabled}
              disabled={busy || !state.supported}
              onChange={(enabled) => save({ enabled })}
            />
            <SettingsToggle
              label="更新后自动恢复"
              hint="尝试重新注入，不保证兼容新版本。"
              checked={state.autoReapply}
              disabled={busy || !state.enabled || !state.supported}
              onChange={(autoReapply) => save({ autoReapply })}
            />
          </div>
          <div className="section-toolbar" style={{ marginTop: 20 }}>
            <span role="status">
              {state.version ? `Desktop ${state.version} · ` : ''}
              {state.patched ? '已注入' : state.status}
            </span>
            <button
              className="button"
              disabled={busy || !state.enabled || !state.compatible}
              onClick={() => void action(() => window.navo.reapplyKimiDesktop())}
            >
              {busy ? '处理中…' : '重新注入'}
            </button>
          </div>
          <p className="settings-description" style={{ marginTop: 16, marginBottom: 0 }}>
            仅支持 macOS · 注入后在 Kimi Code 按 ⌘R 生效。
          </p>
        </>
      ) : (
        <p>正在检测 Desktop…</p>
      )}
      {(error || state?.error) && (
        <p role="alert" className="error-banner">
          {error || state?.error}
        </p>
      )}
    </>
  )
}
