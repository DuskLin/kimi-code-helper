import { useEffect, useRef, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import type { AppInfo, Theme } from '../../shared/contracts'

export function App() {
  const [info, setInfo] = useState<AppInfo>()
  const [theme, setTheme] = useState<Theme>('light')
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const changingTheme = useRef(false)

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
      <main className="empty-workspace" aria-label="工作空间">
        <div className="welcome">
          <div className="app-logo" aria-hidden="true">
            K<span className="logo-dot" />
          </div>
          <h1>Kimi Code Helper</h1>
          <p>你的 Kimi Code 桌面助手</p>
        </div>
      </main>
      <footer className="statusbar">
        <span className="app-status">
          <i className={ready ? 'ready' : ''} />
          {ready ? '工作空间已就绪' : '正在连接桌面服务'}
        </span>
        <span>v{info?.version ?? '0.1.0'}</span>
      </footer>
    </div>
  )
}
