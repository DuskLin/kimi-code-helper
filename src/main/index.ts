import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/contracts'
import { SettingsStore } from './services/settings'

app.setName('Kimi Code Helper')
// 自动化验证使用临时目录，避免改变用户设置。
if (process.env.KIMI_HELPER_TEST_USER_DATA)
  app.setPath('userData', process.env.KIMI_HELPER_TEST_USER_DATA)
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
    const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
    await settings.load()
    nativeTheme.themeSource = settings.get().theme
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
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((error) => {
    console.error('应用启动失败：', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
