import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DashboardSettings } from '../../shared/dashboard'

export function tunnelCredentials(token: string) {
  try {
    const value = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    if (
      !/^[a-f0-9]{32}$/i.test(value.a) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.t) ||
      typeof value.s !== 'string' ||
      Buffer.from(value.s, 'base64').length !== 32 ||
      value.e
    )
      throw new Error()
    return {
      AccountTag: value.a as string,
      TunnelID: value.t as string,
      TunnelSecret: value.s as string
    }
  } catch {
    throw new Error('Tunnel 凭证无效，请粘贴 Cloudflare 提供的完整 Tunnel Token')
  }
}

export class DashboardTunnel {
  state: 'off' | 'connecting' | 'connected' | 'error' = 'off'
  url = ''
  error = ''
  private child?: ChildProcess
  private tokenFile = ''
  private timeout?: ReturnType<typeof setTimeout>
  async cleanup() {
    const files = await readdir(this.directory).catch(() => [])
    for (const file of files)
      if (/^token-[a-f0-9-]+$/.test(file)) await rm(join(this.directory, file), { force: true })
  }
  constructor(
    private binary: string,
    private directory: string,
    private changed: () => void
  ) {}
  async start(settings: DashboardSettings, origin: string, token: string) {
    await this.stop()
    await this.cleanup()
    if (settings.tunnelMode === 'off') return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    // Isolate from the user's global cloudflared configuration and disable updates/metrics exposure.
    const config = join(this.directory, 'empty.yml')
    await writeFile(config, '{}\n', { mode: 0o600 })
    const args = [
      'tunnel',
      '--config',
      config,
      '--no-autoupdate',
      '--metrics',
      '127.0.0.1:0',
      '--loglevel',
      'info'
    ]
    if (settings.tunnelMode === 'quick') args.push('--url', origin)
    else {
      this.tokenFile = join(this.directory, `token-${randomUUID()}`)
      const credentials = tunnelCredentials(token)
      await writeFile(this.tokenFile, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' })
      // Local credentials mode pins ingress and ignores remotely supplied origin routes.
      await writeFile(
        config,
        JSON.stringify({
          tunnel: credentials.TunnelID,
          'credentials-file': this.tokenFile,
          ingress: [
            { hostname: settings.hostname, service: origin },
            { service: 'http_status:404' }
          ]
        }),
        { mode: 0o600 }
      )
      args.push('run', credentials.TunnelID)
      this.url = `https://${settings.hostname}`
    }
    this.state = 'connecting'
    this.error = ''
    this.changed()
    // Pass only basic OS env: never inherit tunnel overrides or application secrets.
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
      if (process.env[key]) env[key] = process.env[key]
    const child = spawn(this.binary, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: this.directory
    })
    this.child = child
    let buffer = ''
    const connections = new Set<string>()
    const receive = (chunk: Buffer) => {
      if (this.child !== child) return
      buffer = (buffer + chunk.toString()).slice(-16384)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (settings.tunnelMode === 'quick') {
          const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)
          if (match) this.url = match[0]
        }
        const index = line.match(/connIndex=(\d+)/)?.[1] ?? '0'
        if (line.includes('Registered tunnel connection')) connections.add(index)
        if (
          /Unregistered tunnel connection|failed to serve tunnel connection|Connection terminated/i.test(
            line
          )
        )
          connections.delete(index)
        if (connections.size && this.url) {
          this.state = 'connected'
          this.error = ''
          clearTimeout(this.timeout)
        } else if (this.state === 'connected') {
          this.state = 'connecting'
          this.error = '网络中断，Tunnel 正在自动重连。'
        }
      }
      this.changed()
      // Raw logs can contain remote configuration or secrets. Never persist or surface them.
    }
    child.stderr?.on('data', receive)
    child.stdout?.on('data', receive)
    child.once('error', () => {
      if (this.child !== child) return
      this.state = 'error'
      this.url = ''
      this.error = '内置 Tunnel 无法启动，请检查安装包是否完整。'
      this.changed()
    })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = undefined
      clearTimeout(this.timeout)
      this.state = 'error'
      this.url = ''
      this.error = 'Tunnel 已断开，请检查网络或凭证后重新连接。'
      this.changed()
      void this.clearToken()
    })
    this.timeout = setTimeout(() => {
      if (this.child !== child || this.state === 'connected') return
      this.state = 'error'
      this.error = 'Tunnel 连接超时，请检查网络或固定域名配置。'
      this.changed()
    }, 45000)
    this.timeout.unref()
  }
  private async clearToken() {
    const file = this.tokenFile
    this.tokenFile = ''
    if (file) await rm(file, { force: true })
  }
  async stop() {
    clearTimeout(this.timeout)
    const child = this.child
    this.child = undefined
    this.state = 'off'
    this.url = ''
    this.error = ''
    this.changed()
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 3000)
        child.kill('SIGTERM')
      })
    }
    await this.clearToken()
  }
  terminate() {
    this.child?.kill('SIGTERM')
  }
}
