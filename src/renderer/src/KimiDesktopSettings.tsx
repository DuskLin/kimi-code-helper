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
        const result = await window.kimiHelper.getKimiDesktop()
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
      window.kimiHelper.saveKimiDesktop({
        enabled: state.enabled,
        autoReapply: state.autoReapply,
        ...patch
      })
    )
  }
  return (
    <>
      <h2>Kimi Code Desktop</h2>
      <p className="settings-description">
        在 Desktop 顶部显示已启用账号的额度或余额，同时显示 1～3 个，更多账号可横向滚动。
      </p>
      {state ? (
        <>
          <div className="card-display-options">
            <SettingsToggle
              label="顶部账号额度"
              hint="展示 Navo 账号池；点击账号查看重置时间。关闭后移除补丁。"
              checked={state.enabled}
              disabled={busy || !state.supported}
              onChange={(enabled) => save({ enabled })}
            />
            <SettingsToggle
              label="更新后自动恢复注入"
              hint="Navo 运行时检测更新；确认资源稳定且页面结构兼容后自动恢复。默认关闭。"
              checked={state.autoReapply}
              disabled={busy || !state.enabled || !state.supported}
              onChange={(autoReapply) => save({ autoReapply })}
            />
          </div>
          <div className="section-toolbar" style={{ marginTop: 20 }}>
            <span role="status">
              {state.version ? `Desktop ${state.version} · ` : ''}
              {state.status}
            </span>
            <button
              className="button"
              disabled={busy || !state.enabled || !state.compatible}
              onClick={() => void action(() => window.kimiHelper.reapplyKimiDesktop())}
            >
              {busy ? '处理中…' : '重新注入'}
            </button>
          </div>
          <p className="settings-description" style={{ marginTop: 16 }}>
            注入后在 Kimi Code 按 ⌘R 或重新打开窗口生效。Navo 不会自动重启 Desktop 或打断会话。
          </p>
          <p className="workspace-note">
            实验功能 · 目前支持 macOS ·
            修改应用资源可能影响签名校验。更新后按当前版本重新备份；布局不兼容时停止注入。额度同步需要
            Navo 保持运行。
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
