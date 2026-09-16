import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  safeStorage
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/contracts'
import { SettingsStore } from './services/settings'
import { GatewayStore, string } from './services/gateway-store'
import { Gateway } from './services/gateway'

app.setName('Kimi Code Helper')
// 自动化验证使用临时目录，避免改变用户设置。
if (process.env.KIMI_HELPER_TEST_USER_DATA)
  app.setPath('userData', process.env.KIMI_HELPER_TEST_USER_DATA)
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
let gateway: Gateway | undefined
let quitting = false
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
})
const rendererFile = join(__dirname, '../renderer/index.html')
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const trustedUrl = developmentUrl
  ? new URL(developmentUrl).origin
  : pathToFileURL(rendererFile).href

function isTrusted(url: string): boolean {
  if (developmentUrl) {
    try {
      return new URL(url).origin === trustedUrl
    } catch {
      return false
    }
  }
  return url.split('#')[0] === trustedUrl
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 440,
    title: 'Kimi Code Helper',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151719' : '#f8f9fa',
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 22, y: 22 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrusted(url)) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  const loading = developmentUrl ? window.loadURL(developmentUrl) : window.loadFile(rendererFile)
  void loading.catch((error) => console.error('窗口加载失败：', error))
}

void app
  .whenReady()
  .then(async () => {
    if (!ownsInstance) return
    const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
    await settings.load()
    nativeTheme.themeSource = settings.get().theme
    const gatewayStore = new GatewayStore(join(app.getPath('userData'), 'gateway.json'), {
      encrypt: (value) => {
        if (
          !safeStorage.isEncryptionAvailable() ||
          (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
        )
          throw new Error('系统安全存储不可用，请解锁钥匙串或启用系统密钥环后重试')
        return safeStorage.encryptString(value).toString('base64')
      },
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
    })
    await gatewayStore.load()
    const service = new Gateway(gatewayStore)
    await service.pricing.load()
    gateway = service
    const handle = (channel: string, callback: (value: unknown) => unknown): void => {
      ipcMain.handle(channel, (event, value: unknown) => {
        if (
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          !isTrusted(event.senderFrame.url)
        ) {
          throw new Error('不允许的调用来源')
        }
        return callback(value)
      })
    }
    handle(IPC.appInfo, () => ({
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron
    }))
    handle(IPC.settingsGet, () => settings.get())
    handle(IPC.settingsSave, async (value) => {
      const saved = await settings.save(value)
      nativeTheme.themeSource = saved.theme
      return saved
    })
    handle(IPC.gatewayGet, () => service.snapshot())
    handle(IPC.requestHistory, (before) => service.history.page(before as number | undefined))
    handle(IPC.usageStats, (query) =>
      service.history.usage(query as import('../shared/usage').UsageQuery, service.snapshot())
    )
    handle(IPC.accountSave, (value) => service.saveAccount(value))
    handle(IPC.accountInspect, (value) => service.inspectAccount(value))
    handle(IPC.accountRefresh, (value) => service.refreshAccount(value))
    handle(IPC.accountDelete, async (value) => {
      await gatewayStore.deleteAccount(value)
      service.scheduler.prune(gatewayStore.get().accounts)
      return service.snapshot()
    })
    handle(IPC.accountReset, (value) => {
      const id = string(value, '账号 ID')
      if (!gatewayStore.get().accounts.some((a) => a.id === id)) throw new Error('账号不存在')
      service.scheduler.reset(id)
      return service.snapshot()
    })
    handle(IPC.modelPriceRefresh, async (force) => {
      if (force !== undefined && typeof force !== 'boolean') throw new Error('刷新参数无效')
      await service.pricing.refresh(force as boolean | undefined)
      return service.snapshot()
    })
    handle(IPC.quotaCardOrderSave, async (value) => {
      await gatewayStore.saveQuotaCardOrder(value)
      return service.snapshot()
    })
    handle(IPC.modelPriceSave, async (value) => {
      await gatewayStore.saveModelPrice(value)
      return service.snapshot()
    })
    handle(IPC.gatewaySave, (value) => service.saveSettings(value))
    handle(IPC.gatewayRunning, (value) => service.setRunning(value))
    handle(IPC.connectionCopy, async (value) => {
      // 保存默认分组后再复制，避免尚未落盘的密钥在重启后变化。
      await gatewayStore.mutate(() => {})
      clipboard.writeText(service.connection(value))
    })
    if (gatewayStore.get().settings.autoStart) {
      try {
        await service.setRunning(true)
      } catch {
        /* 启动错误在界面呈现，仍允许更换端口。 */
      }
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' }
      ])
    )
    createWindow()
    void service.refreshStaleAccounts()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error) => {
    console.error('应用启动失败：', error)
    dialog.showErrorBox(
      'Kimi Code Helper 启动失败',
      error instanceof Error ? error.message : '无法读取本地配置'
    )
    app.quit()
  })

app.on('before-quit', (event) => {
  if (!gateway || quitting) return
  event.preventDefault()
  quitting = true
  void gateway.shutdown().finally(() => {
    app.quit()
  })
})

// before-quit / will-quit 可被取消；仅在不可取消的实际退出事件关闭数据库。
app.on('quit', () => gateway?.history.close())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
