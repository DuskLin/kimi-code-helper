import { useEffect, useState } from 'react'
import { Globe, Copy, ExternalLink, ShieldCheck, RefreshCw } from 'lucide-react'
import { Modal } from './Modal'
import type { DashboardSettings as Settings, DashboardState } from '../../shared/dashboard'

export function DashboardSettings() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<DashboardState>()
  const [form, setForm] = useState<Settings>()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!open) return
    let alive = true
    const poll = () =>
      window.kimiHelper
        .getDashboard()
        .then((s) => {
          if (alive) {
            setState(s)
            setForm((f) => f ?? s.settings)
          }
        })
        .catch(() => {
          if (alive) setMessage('无法读取仪表盘状态')
        })
    void poll()
    const timer = setInterval(poll, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open])
  async function action(fn: () => Promise<unknown>, success = '') {
    setBusy(true)
    setMessage('')
    try {
      await fn()
      setState(await window.kimiHelper.getDashboard())
      setMessage(success)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  const close = () => {
    setOpen(false)
    setToken('')
    setMessage('')
  }
  const checkStatus = state?.publicCheck?.status ?? 'idle'
  const checkLabel = {
    idle: '等待连接',
    checking: '正在检测',
    reachable: '公网已验证',
    protected: '需 Access 登录',
    unreachable: '本机检测未通过'
  }[checkStatus]
  return (
    <>
      <button
        className="button"
        onClick={() => {
          setForm(undefined)
          setMessage('')
          setOpen(true)
        }}
      >
        <Globe size={15} />
        远程仪表盘
      </button>
      {open && (
        <Modal
          title="远程仪表盘"
          close={close}
          className="dashboard-settings-modal"
          footer={
            form && state ? (
              <footer className="dashboard-dialog-footer">
                <span className="dashboard-feedback" role="status">
                  {message || '设置将在保存后生效'}
                </span>
                <div>
                  <button className="button" onClick={close}>
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await window.kimiHelper.saveDashboard({
                          ...form,
                          ...(token ? { token } : {})
                        })
                        setToken('')
                      }, '设置已应用')
                    }
                  >
                    {busy ? '处理中…' : '保存并应用'}
                  </button>
                </div>
              </footer>
            ) : undefined
          }
        >
          {form && state ? (
            <div className="dashboard-settings-content">
              <section className="dashboard-section" aria-labelledby="dashboard-access-title">
                <div className="dashboard-section-heading">
                  <h3 id="dashboard-access-title">访问设置</h3>
                  <span className={`dashboard-status ${state.running ? 'is-ok' : ''}`}>
                    {state.running ? '服务运行中' : '服务已停止'}
                  </span>
                </div>
                <div className="dashboard-toggle-grid">
                  <label className="dashboard-toggle-row">
                    <span>
                      <strong>启用仪表盘</strong>
                      <small>只读查看账号额度与用量</small>
                    </span>
                    <input
                      aria-label="启用只读仪表盘"
                      type="checkbox"
                      role="switch"
                      checked={form.enabled}
                      onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    />
                  </label>
                  <label className="dashboard-toggle-row">
                    <span>
                      <strong>局域网访问</strong>
                      <small>同一网络内通过 HTTPS 访问</small>
                    </span>
                    <input
                      aria-label="允许局域网访问（HTTPS）"
                      type="checkbox"
                      role="switch"
                      checked={form.lan}
                      onChange={(e) => setForm({ ...form, lan: e.target.checked })}
                    />
                  </label>
                </div>
                <div className="dashboard-field-grid">
                  <label className="field">
                    <span>HTTPS 端口</span>
                    <input
                      type="number"
                      min={1024}
                      max={65534}
                      value={form.port}
                      onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    <span>公网访问</span>
                    <select
                      value={form.tunnelMode}
                      onChange={(e) =>
                        setForm({ ...form, tunnelMode: e.target.value as Settings['tunnelMode'] })
                      }
                    >
                      <option value="off">关闭公网访问</option>
                      <option value="quick">临时链接 · 重启后变化</option>
                      <option value="named">固定域名</option>
                    </select>
                  </label>
                </div>
                {form.tunnelMode === 'named' && (
                  <div className="dashboard-named-fields">
                    <label className="field">
                      <span>固定域名</span>
                      <input
                        placeholder="quota.example.com"
                        value={form.hostname}
                        onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Tunnel Token</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={token}
                        placeholder={
                          state.hasTunnelToken
                            ? '已安全保存，留空保持不变'
                            : '粘贴 Cloudflare Tunnel Token'
                        }
                        onChange={(e) => setToken(e.target.value)}
                      />
                    </label>
                    <details className="dashboard-disclosure">
                      <summary>固定域名配置说明</summary>
                      <p>
                        在 Cloudflare 创建专用 Tunnel，将域名的代理 CNAME 指向对应的 Tunnel
                        ID.cfargotunnel.com。App 内置连接器并限定转发到只读仪表盘，建议同时配置
                        Cloudflare Access 身份验证。
                      </p>
                    </details>
                  </div>
                )}
              </section>
              <section className="dashboard-section" aria-labelledby="dashboard-address-title">
                <div className="dashboard-section-heading">
                  <h3 id="dashboard-address-title">连接地址</h3>
                  {state.publicUrl && (
                    <span
                      className={`dashboard-status ${checkStatus === 'reachable' ? 'is-ok' : checkStatus === 'unreachable' ? 'is-warning' : ''}`}
                    >
                      {checkLabel}
                    </span>
                  )}
                </div>
                <div className="dashboard-addresses">
                  <div className="dashboard-address-row">
                    <span className="dashboard-address-label">本机</span>
                    <code title={state.localUrl}>{state.localUrl}</code>
                    <button
                      className="button dashboard-inline-action"
                      disabled={busy || !state.running}
                      onClick={() => void action(() => window.kimiHelper.openDashboard())}
                    >
                      <ExternalLink size={13} />
                      打开
                    </button>
                  </div>
                  <div className="dashboard-address-row">
                    <span className="dashboard-address-label">局域网</span>
                    <div className="dashboard-address-list">
                      {state.lanUrls.length ? (
                        state.lanUrls.map((url) => (
                          <code key={url} title={url}>
                            {url}
                          </code>
                        ))
                      ) : (
                        <span className="dashboard-empty">未开放</span>
                      )}
                    </div>
                  </div>
                  <div className="dashboard-address-row">
                    <span className="dashboard-address-label">公网</span>
                    {state.publicUrl ? (
                      <>
                        <code title={state.publicUrl}>{state.publicUrl}</code>
                        <button
                          className="button dashboard-inline-action"
                          disabled={busy}
                          onClick={() =>
                            void action(
                              () => window.kimiHelper.copyDashboardUrl(),
                              '公网地址已复制'
                            )
                          }
                        >
                          <Copy size={13} />
                          复制
                        </button>
                      </>
                    ) : (
                      <span className="dashboard-empty">
                        {state.tunnel === 'connecting' ? '正在生成链接…' : '尚未生成'}
                      </span>
                    )}
                  </div>
                </div>
                {state.settings.tunnelMode !== 'off' && (
                  <div className="dashboard-connection-meta">
                    <details className="dashboard-disclosure">
                      <summary>
                        连接诊断 ·{' '}
                        {
                          {
                            off: '已关闭',
                            connecting: '连接中',
                            connected: '连接器在线',
                            error: '连接异常'
                          }[state.tunnel]
                        }
                      </summary>
                      <p>
                        {state.publicCheck?.message || '等待公网可达性校验。'}
                        {state.publicCheck?.checkedAt && (
                          <>
                            <br />
                            检测时间：
                            {new Date(state.publicCheck.checkedAt).toLocaleTimeString('zh-CN')}
                          </>
                        )}
                      </p>
                    </details>
                    <button
                      className="button dashboard-inline-action"
                      disabled={busy || state.tunnel !== 'connected' || checkStatus === 'checking'}
                      onClick={() => void action(() => window.kimiHelper.checkDashboardPublic())}
                    >
                      <RefreshCw size={12} />
                      重新检测
                    </button>
                  </div>
                )}
                {state.error && (
                  <p className="dashboard-error" role="alert">
                    {state.error}
                  </p>
                )}
              </section>
              <section
                className="dashboard-section dashboard-security"
                aria-labelledby="dashboard-security-title"
              >
                <div className="dashboard-code-row">
                  <div>
                    <h3 id="dashboard-security-title">
                      <ShieldCheck size={15} />
                      访问安全
                    </h3>
                    <p>链接不含访问码，请分开发送。登录有效期为 8 小时。</p>
                  </div>
                  <button
                    className="button"
                    disabled={busy || !state.running}
                    onClick={() =>
                      void action(
                        () => window.kimiHelper.copyDashboardCode(),
                        '访问码已复制，请粘贴到仪表盘登录页'
                      )
                    }
                  >
                    <Copy size={14} />
                    复制访问码
                  </button>
                </div>
                <details className="dashboard-disclosure dashboard-security-details">
                  <summary>证书与访问管理</summary>
                  <p>
                    局域网首次访问使用自签名证书，请核对以下 SHA-256 指纹后信任。公网使用 Cloudflare
                    HTTPS。
                  </p>
                  <code className="dashboard-fingerprint">{state.fingerprint || '启用后生成'}</code>
                  <div className="dashboard-reset-row">
                    <span>重置后，所有已登录设备立即退出。</span>
                    <button
                      className="button dashboard-danger"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () => window.kimiHelper.rotateDashboardCode(),
                          '访问码已重置，所有设备已退出'
                        )
                      }
                    >
                      重置访问码
                    </button>
                  </div>
                </details>
              </section>
            </div>
          ) : (
            <p>{message || '正在读取…'}</p>
          )}
        </Modal>
      )}
    </>
  )
}
