import { useEffect, useRef, useState } from 'react'
import { Check, KeyRound, Link2, Moon, Sun } from 'lucide-react'
import type { AppInfo, Theme } from '../../shared/contracts'
import { GatewayPanel, type GatewayStatus } from './GatewayPanel'
import appLogo from './assets/kimi-code-helper-logo.png'
import { UpdateControl } from './UpdateControl'

export function App() {
  const [info, setInfo] = useState<AppInfo>()
  const [theme, setTheme] = useState<Theme>('light')
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>()
  const changingTheme = useRef(false)
  const copying = useRef(false)
  const [copied, setCopied] = useState<'url' | 'key'>()
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(undefined), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  async function copyConnection(format: 'url' | 'key') {
    if (copying.current) return
    copying.current = true
    setCopied(undefined)
    try {
      await window.kimiHelper.copyConnection({ groupId: 'default', format })
      setCopied(format)
    } catch {
      setError('复制失败，请重试。')
    } finally {
      copying.current = false
    }
  }

  useEffect(() => {
    let active = true
    async function initialize() {
      try {
        const [appInfo, settings] = await Promise.all([
          window.kimiHelper.getAppInfo(),
          window.kimiHelper.getSettings()
        ])
        if (!active) return
        document.documentElement.dataset.theme = settings.theme
        setTheme(settings.theme)
        setInfo(appInfo)
        setReady(true)
      } catch {
        if (active) setError('桌面服务连接失败，请重新打开应用。')
      }
    }
    void initialize()
    return () => {
      active = false
    }
  }, [])

  async function changeTheme(next: Theme) {
    if (changingTheme.current || next === theme) return
    changingTheme.current = true
    setSaving(true)
    try {
      const saved = await window.kimiHelper.saveSettings({ theme: next })
      document.documentElement.dataset.theme = saved.theme
      setTheme(saved.theme)
      setError('')
    } catch {
      setError('主题保存失败，请稍后重试。')
    } finally {
      changingTheme.current = false
      setSaving(false)
    }
  }

  return (
    <div className={`app-shell ${info?.platform === 'darwin' ? 'macos' : ''}`}>
      <header className="titlebar">
        <div className="app-brand" aria-label="Kimi Code Helper">
          <img src={appLogo} alt="" aria-hidden="true" />
          <span>Kimi Code Helper</span>
        </div>
        <div className="theme-control" role="group" aria-label="展示模式">
          <button
            aria-label="浅色模式"
            aria-pressed={theme === 'light'}
            title="浅色模式"
            className={theme === 'light' ? 'selected' : ''}
            disabled={!ready || saving}
            onClick={() => {
              void changeTheme('light')
            }}
          >
            <Sun size={15} />
          </button>
          <button
            aria-label="深色模式"
            aria-pressed={theme === 'dark'}
            title="深色模式"
            className={theme === 'dark' ? 'selected' : ''}
            disabled={!ready || saving}
            onClick={() => {
              void changeTheme('dark')
            }}
          >
            <Moon size={15} />
          </button>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => location.reload()}>重新加载</button>
        </div>
      )}
      <main className="workspace" aria-label="工作空间">
        {ready && <GatewayPanel onStatusChange={setGatewayStatus} />}
      </main>
      <footer className="statusbar">
        <div className="statusbar-connection">
          <span className="app-status" role="status" title={gatewayStatus?.error || undefined}>
            <i className={gatewayStatus?.running && !gatewayStatus.error ? 'ready' : ''} />
            {gatewayStatus?.error
              ? '网关状态获取失败'
              : !gatewayStatus
                ? '正在获取网关状态…'
                : gatewayStatus.running
                  ? '网关运行中'
                  : '网关已停止'}
            {!!gatewayStatus?.port && <span> · 127.0.0.1:{gatewayStatus.port}</span>}
          </span>
          {gatewayStatus?.running && !gatewayStatus.error && (
            <div className="statusbar-copy-actions">
              <button
                className="statusbar-copy"
                aria-label="复制 URL"
                title="复制网关 URL（包含 /v1）"
                onClick={() => void copyConnection('url')}
              >
                {copied === 'url' ? <Check size={12} /> : <Link2 size={12} />}
              </button>
              <button
                className="statusbar-copy"
                aria-label="复制 Key"
                title="复制网关 Key"
                onClick={() => void copyConnection('key')}
              >
                {copied === 'key' ? <Check size={12} /> : <KeyRound size={12} />}
              </button>
            </div>
          )}
        </div>
        <UpdateControl version={info?.version} />
      </footer>
    </div>
  )
}
