export interface PublicCheckState {
  status: 'idle' | 'checking' | 'reachable' | 'protected' | 'unreachable'
  checkedAt: number | null
  message: string
}

export async function probeDashboard(
  url: string,
  request: typeof fetch,
  signal: AbortSignal
): Promise<PublicCheckState> {
  const checkedAt = Date.now()
  try {
    const response = await request(`${url}/api/snapshot`, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
      signal
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get('location') ?? '', url)
      if (
        target.protocol === 'https:' &&
        (target.hostname.endsWith('.cloudflareaccess.com') ||
          (target.origin === url && target.pathname.startsWith('/cdn-cgi/access/')))
      )
        return {
          status: 'protected',
          checkedAt,
          message: '已到达 Cloudflare Access，请在浏览器完成身份验证。'
        }
    }
    if (response.status === 401) {
      const reader = response.body?.getReader()
      let body = ''
      let size = 0
      if (reader) {
        const decoder = new TextDecoder()
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > 4096) break
            body += decoder.decode(chunk.value, { stream: true })
          }
          body += decoder.decode()
        } finally {
          await reader.cancel()
        }
      }
      if (size <= 4096 && JSON.parse(body).error === '请登录仪表盘')
        return {
          status: 'reachable',
          checkedAt,
          message: '已从本机通过公网 HTTPS 到达仪表盘，匿名读取已被鉴权拦截。'
        }
    }
    return {
      status: 'unreachable',
      checkedAt,
      message: `公网校验返回 HTTP ${response.status}，请检查域名传播、Tunnel 转发配置或 Cloudflare Access。`
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : ''
    return {
      status: 'unreachable',
      checkedAt,
      message: /ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED/.test(cause)
        ? '本机尚不能解析该域名；临时域名可能仍在传播，或 DNS 缓存了不存在的结果。将自动重试。'
        : '本机公网 HTTPS 校验失败，请检查代理／DNS／网络。连接器已连接不代表此网络能访问该地址；可换手机移动网络验证。'
    }
  }
}

export class DashboardPublicCheck {
  state: PublicCheckState = { status: 'idle', checkedAt: null, message: '' }
  private url = ''
  private enabled = false
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private work?: Promise<void>
  constructor(private request: typeof fetch) {}
  configure(url: string, enabled: boolean) {
    if (url === this.url && enabled === this.enabled) return
    this.controller?.abort()
    this.controller = undefined
    clearTimeout(this.timer)
    this.work = undefined
    this.url = url
    this.enabled = enabled
    this.state = { status: enabled ? 'checking' : 'idle', checkedAt: null, message: '' }
    if (enabled) void this.check()
  }
  check(): Promise<void> {
    if (!this.enabled || !this.url) return Promise.resolve()
    if (this.work) return this.work
    clearTimeout(this.timer)
    const controller = new AbortController()
    this.controller = controller
    this.state = { ...this.state, status: 'checking' }
    const timeout = setTimeout(() => controller.abort(), 10000)
    this.work = probeDashboard(this.url, this.request, controller.signal)
      .then((state) => {
        if (this.controller === controller) this.state = state
      })
      .finally(() => {
        clearTimeout(timeout)
        if (this.controller !== controller) return
        this.work = undefined
        if (this.enabled) {
          this.timer = setTimeout(
            () => void this.check(),
            this.state.status === 'unreachable' ? 15000 : 60000
          )
          this.timer.unref()
        }
      })
    return this.work
  }
  close() {
    this.configure('', false)
  }
}
