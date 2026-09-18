import { readFile, writeFile, mkdir, rename, unlink, access } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { KimiDesktopPreferences, KimiDesktopState } from '../../shared/kimi-desktop'

export const KIMI_DESKTOP_APP = '/Applications/Kimi Code.app'
const OWN_TAG =
  /<!-- navo-quota-experiment --><script defer src="\/assets\/navo-quota-widget\.js(?:\?v=[a-f0-9]+)?"><\/script>(?:\n {2})?/g
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'

// 只修改独立页面入口与自有资源；按原始入口摘要保存备份，绝不用旧版覆盖新版。
export class KimiDesktopIntegration {
  private userData: string
  private appPath: string
  private widget: string
  private supported: boolean
  private preferences: KimiDesktopPreferences = {
    enabled: false,
    autoReapply: false,
    accountQuota: true,
    sessionStats: true
  }
  private queue: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private candidate = ''
  private state: KimiDesktopState

  constructor(
    userData: string,
    widget: string,
    appPath = KIMI_DESKTOP_APP,
    platform = process.platform
  ) {
    this.userData = userData
    this.widget = widget
    this.appPath = appPath
    this.supported = platform === 'darwin'
    this.state = {
      ...this.preferences,
      supported: this.supported,
      installed: false,
      compatible: false,
      patched: false,
      version: '',
      status: '尚未检测',
      error: ''
    }
  }
  private get dir() {
    return join(this.appPath, 'Contents/Resources/desktop-dist')
  }
  private get tag() {
    return `<!-- navo-quota-experiment --><script defer src="/assets/navo-quota-widget.js?v=${hash(this.widget).slice(0, 16)}"></script>`
  }
  private get marker() {
    return join(this.userData, 'kimi-quota-experiment.enabled')
  }
  private get config() {
    return join(this.userData, 'kimi-desktop-integration.json')
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn)
    this.queue = result.catch(() => {})
    return result
  }
  private async atomic(path: string, value: string, mode = 0o600) {
    await writeFile(`${path}.tmp`, value, { mode })
    await rename(`${path}.tmp`, path)
  }
  async load() {
    try {
      this.preferences = this.validate(JSON.parse(await readFile(this.config, 'utf8')))
    } catch (e) {
      if (!absent(e)) this.state.error = '无法读取集成设置，已保持关闭'
      else {
        try {
          await access(this.marker)
          this.preferences.enabled = true
        } catch {}
      }
    }
    await this.check()
  }
  private validate(value: unknown): KimiDesktopPreferences {
    const p = value as KimiDesktopPreferences | null
    if (!p || typeof p.enabled !== 'boolean' || typeof p.autoReapply !== 'boolean')
      throw new Error('桌面集成设置无效')
    for (const key of ['accountQuota', 'sessionStats'] as const) {
      if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error('桌面集成设置无效')
    }
    return {
      enabled: p.enabled,
      autoReapply: p.autoReapply,
      accountQuota: p.accountQuota ?? true,
      sessionStats: p.sessionStats ?? true
    }
  }
  getState(): KimiDesktopState {
    return { ...this.state, ...this.preferences }
  }
  private async inspect() {
    this.state = {
      ...this.state,
      installed: false,
      patched: false,
      compatible: false,
      version: '',
      error: ''
    }
    if (!this.supported) {
      this.state.status = '目前仅支持 macOS'
      return null
    }
    try {
      const html = await readFile(join(this.dir, 'index.html'), 'utf8')
      this.state.installed = true
      const plist = await readFile(join(this.appPath, 'Contents/Info.plist'), 'utf8')
      this.state.version =
        plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ??
        '未知'
      // 仅接受已知布局特征；版本号本身不能证明兼容。
      const script = html.match(/src="\/assets\/(main-[^"/]+\.js)"/)?.[1]
      const css = html.match(/href="\/assets\/(main-[^"/]+\.css)"/)?.[1]
      let resourceHash = ''
      if (script && css && html.includes('</body>')) {
        const [js, style] = await Promise.all([
          readFile(join(this.dir, 'assets', basename(script)), 'utf8'),
          readFile(join(this.dir, 'assets', basename(css)), 'utf8')
        ])
        this.state.compatible =
          js.includes('ch-spacer') && style.includes('.chat-header') && style.includes('.ch-spacer')
        resourceHash = hash(js + style)
      }
      let widget = ''
      try {
        widget = await readFile(join(this.dir, 'assets/navo-quota-widget.js'), 'utf8')
      } catch {}
      this.state.patched = html.includes(this.tag) && widget === this.widget
      this.state.status = !this.state.compatible
        ? '页面结构不兼容，已停止注入'
        : this.state.patched
          ? '已注入 · 刷新 Kimi Code 窗口可加载最新版本'
          : this.preferences.enabled
            ? '补丁缺失或需要更新，请重新注入'
            : '未启用'
      return { html, fingerprint: hash(html + this.state.version + resourceHash) }
    } catch (e) {
      this.state.status = absent(e)
        ? '未找到完整的 Kimi Code Desktop 安装'
        : '无法读取 Kimi Code Desktop'
      this.state.error = absent(e) ? '' : (e as Error).message
      return null
    }
  }
  check() {
    return this.exclusive(async () => {
      await this.inspect()
      return this.getState()
    })
  }
  private async install() {
    const inspected = await this.inspect()
    if (!inspected || !this.state.compatible) throw new Error(this.state.status)
    const { html } = inspected
    // 迁移第一版补丁，去除我们自己的精确标记，保留其他页面内容。
    const original = html.replace(OWN_TAG, '')
    const backup = join(this.userData, 'kimi-desktop-backups', hash(original))
    await mkdir(backup, { recursive: true, mode: 0o700 })
    try {
      await writeFile(join(backup, 'index.html'), original, { flag: 'wx', mode: 0o600 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if ((await readFile(join(backup, 'index.html'), 'utf8')) !== original)
        throw new Error('原始入口备份校验失败')
    }
    const patched = original.replace('</body>', `${this.tag}\n  </body>`)
    await this.atomic(
      join(backup, 'manifest.json'),
      JSON.stringify({
        version: this.state.version,
        original: hash(original),
        patched: hash(patched)
      })
    )
    // 检测期间安装包可能仍在被官方更新，写入前再次确认入口没有变化。
    if ((await readFile(join(this.dir, 'index.html'), 'utf8')) !== html)
      throw new Error('Kimi Code 正在更新，请稍后重新注入')
    await this.atomic(join(this.dir, 'assets/navo-quota-widget.js'), this.widget, 0o644)
    await this.atomic(join(this.dir, 'index.html'), patched, 0o644)
    await writeFile(this.marker, 'enabled\n', { mode: 0o600 })
    await this.inspect()
  }
  private async remove() {
    await unlink(this.marker).catch((e) => {
      if (!absent(e)) throw e
    })
    let html: string
    try {
      html = await readFile(join(this.dir, 'index.html'), 'utf8')
    } catch (e) {
      if (absent(e)) return
      throw e
    }
    const clean = html.replace(OWN_TAG, '')
    if (clean !== html) {
      await this.atomic(join(this.dir, 'index.html'), clean, 0o644)
    }
    // 已打开的页面下次轮询立即隐藏；不需要强制刷新或重启用户会话。
    await this.atomic(
      join(this.dir, 'assets/navo-quota-data.json'),
      JSON.stringify({ enabled: false, exportedAt: Date.now(), accounts: [] })
    )
    await unlink(join(this.dir, 'assets/navo-quota-widget.js')).catch((e) => {
      if (!absent(e)) throw e
    })
  }
  save(value: unknown) {
    return this.exclusive(async () => {
      const next = this.validate(value)
      await mkdir(this.userData, { recursive: true })
      // 先保存用户关闭意图，防止下次启动自动重新注入。
      if (!next.enabled) {
        await this.atomic(this.config, JSON.stringify(next))
        this.preferences = next
        await this.remove()
      } else {
        if (!this.preferences.enabled || !this.state.patched) await this.install()
        await this.atomic(this.config, JSON.stringify(next))
        this.preferences = next
      }
      this.candidate = ''
      await this.inspect()
      return this.getState()
    })
  }
  reapply() {
    return this.exclusive(async () => {
      if (!this.preferences.enabled) throw new Error('请先启用桌面集成')
      await this.install()
      return this.getState()
    })
  }
  // 连续两次检测安装资源稳定后才自动恢复；默认关闭自动恢复。
  monitor() {
    return this.exclusive(async () => {
      const found = await this.inspect()
      if (
        !this.preferences.enabled ||
        !this.preferences.autoReapply ||
        !found ||
        !this.state.compatible ||
        this.state.patched
      ) {
        this.candidate = ''
        return
      }
      if (this.candidate === found.fingerprint) {
        try {
          await this.install()
        } catch (e) {
          this.state.error = (e as Error).message
          this.state.status = '自动注入失败，可手动重试'
        }
        this.candidate = ''
      } else this.candidate = found.fingerprint
    })
  }
  start() {
    this.timer = setInterval(() => {
      void this.monitor().catch(() => {})
    }, 30_000)
    this.timer.unref()
  }
  close() {
    clearInterval(this.timer)
  }
}
