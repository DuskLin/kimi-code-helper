import { useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'
import type { UpdateState } from '../../shared/updates'

export function UpdateControl({ version }: { version?: string }) {
  const [state, setState] = useState<UpdateState>()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await window.kimiHelper.getUpdateState()
        if (active) setState(next)
      } catch {
        if (active) setError('更新服务连接失败，请重新打开应用。')
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    if (open) dialog.current?.showModal()
  }, [open])

  const actionable = state && ['available', 'downloaded'].includes(state.status)
  const busy = state && ['checking', 'downloading', 'installing'].includes(state.status)
  const messages: Record<UpdateState['status'], string> = {
    disabled: '开发模式',
    idle: '启动后自动检查更新',
    checking: '正在检查更新…',
    available: `发现新版本 v${state?.version}`,
    downloading: `正在下载 v${state?.version} · ${Math.round(state?.progress ?? 0)}%`,
    downloaded: `v${state?.version} 已就绪`,
    installing: '正在准备重启安装…',
    'up-to-date': '已是最新正式版本',
    error: '更新失败'
  }
  async function act(action: () => Promise<void>) {
    setError('')
    try {
      await action()
      setState(await window.kimiHelper.getUpdateState())
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : '操作失败，请重试。'
      )
    }
  }
  return (
    <>
      {state?.version &&
        state.version !== dismissedVersion &&
        ['downloading', 'downloaded', 'available'].includes(state.status) && (
          <aside className="update-notice" aria-label="新版本更新提示">
            <div>
              <strong>发现新版本 v{state.version}</strong>
              <p role="status">{messages[state.status]}</p>
            </div>
            <button className="button" onClick={() => setOpen(true)}>
              查看更新
            </button>
            <button
              className="icon-button"
              aria-label="收起更新提示"
              onClick={() => setDismissedVersion(state.version)}
            >
              <X size={14} />
            </button>
          </aside>
        )}
      <button
        className={`statusbar-copy update-trigger ${actionable ? 'update-ready' : ''}`}
        onClick={() => setOpen(true)}
        title="检查应用更新"
        aria-label="应用更新"
      >
        <ArrowUpCircle size={13} />
        {actionable
          ? messages[state.status]
          : state?.status === 'downloading'
            ? `下载更新 ${Math.round(state.progress)}%`
            : `v${version ?? '…'} · 检查更新`}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="modal update-dialog"
          aria-label="应用更新"
          onCancel={(event) => {
            event.preventDefault()
            setOpen(false)
          }}
        >
          <div className="modal-heading">
            <h2>应用更新</h2>
            <button className="icon-button" aria-label="关闭对话框" onClick={() => setOpen(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="update-content">
            <p>当前版本 v{state?.currentVersion ?? version ?? '…'}</p>
            <p role="status">{state ? messages[state.status] : '正在连接更新服务…'}</p>
            {state?.status === 'downloading' && (
              <progress aria-label="更新下载进度" max={100} value={state.progress} />
            )}
            <p className="update-hint">
              {state?.canInstall
                ? '自动检查正式版本并在后台下载；下载完成后由你决定何时重启安装。'
                : '自动检查 GitHub 上的正式版本，发现新版后可下载安装包。'}
            </p>
            {state?.reason && <p className="update-hint">{state.reason}</p>}
            {(error || state?.error) && (
              <p className="update-error" role="alert">
                {error || state?.error}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="button"
                onClick={() => void act(() => window.kimiHelper.openReleasePage())}
              >
                发布页
              </button>
              {state?.status === 'downloaded' ? (
                <button
                  className="button primary"
                  onClick={() => void act(() => window.kimiHelper.installUpdate())}
                >
                  重启并安装
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={!state || !!busy || state.status === 'disabled'}
                  onClick={() => void act(() => window.kimiHelper.checkForUpdates())}
                >
                  {state?.status === 'error' ? '重试更新' : '检查更新'}
                </button>
              )}
            </div>
          </div>
        </dialog>
      )}
    </>
  )
}
