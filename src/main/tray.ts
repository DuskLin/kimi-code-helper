import { app, Menu, nativeImage, Tray } from 'electron'
import appLogo from '../renderer/src/assets/kimi-code-helper-logo.png?asset'

function trayIcon(source: Electron.NativeImage, phase?: number): Electron.NativeImage {
  const icon = nativeImage.createEmpty()
  for (const scaleFactor of [1, 2]) {
    const size = 18 * scaleFactor
    const pixels = source.resize({ width: size, height: size }).toBitmap()
    // Sweep a blue ribbon clockwise around the logo, preserving its alpha mask.
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const x = (offset / 4) % size
      const y = Math.floor(offset / 4 / size)
      const angle = (Math.atan2(y - size / 2, x - size / 2) / (2 * Math.PI) + 1.25) % 1
      const distance = phase === undefined ? 1 : (phase - angle + 1) % 1
      const blue = phase === undefined ? 0 : Math.pow(Math.max(0, 1 - distance / 0.45), 0.7)
      const alpha = pixels[offset + 3]
      // Premultiplied BGRA; retain white outside the moving blue trail.
      pixels[offset] = alpha
      pixels[offset + 1] = Math.round(alpha * (1 - blue * 0.48))
      pixels[offset + 2] = Math.round(alpha * (1 - blue))
    }
    icon.addRepresentation({
      scaleFactor,
      buffer: nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG()
    })
  }
  // Keep the requested white color instead of letting macOS recolor a template.
  icon.setTemplateImage(false)
  return icon
}

export function createTray(
  showWindow: () => void,
  subscribe: (listener: (count: number) => void) => () => void
): Tray {
  const source = nativeImage.createFromPath(appLogo)
  if (source.isEmpty()) throw new Error('无法加载应用 Logo')
  const idleIcon = trayIcon(source)
  // Cache frames once; animation never decodes the logo or reads gateway snapshots.
  const frames = Array.from({ length: 30 }, (_, index) => trayIcon(source, index / 30))
  const tray = new Tray(idleIcon)
  let timer: ReturnType<typeof setInterval> | undefined
  let frame = 0
  const unsubscribe = subscribe((count) => {
    if (tray.isDestroyed()) return
    tray.setToolTip(
      count > 0 ? `Kimi Code Helper · 正在处理 ${count} 个请求` : 'Kimi Code Helper · 空闲'
    )
    if (count > 0 && !timer) {
      frame = 0
      tray.setImage(frames[frame])
      timer = setInterval(() => {
        if (tray.isDestroyed()) {
          clearInterval(timer)
          timer = undefined
          return
        }
        frame = (frame + 1) % frames.length
        tray.setImage(frames[frame])
      }, 50)
      timer.unref()
    } else if (count === 0) {
      clearInterval(timer)
      timer = undefined
      tray.setImage(idleIcon)
    }
  })
  app.once('quit', () => {
    unsubscribe()
    clearInterval(timer)
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { label: '关闭窗口后，网关继续在后台运行', enabled: false },
      { type: 'separator' },
      { label: '退出 Kimi Code Helper', click: () => app.quit() }
    ])
  )
  // macOS single click opens the menu; Windows/Linux can also restore directly.
  if (process.platform !== 'darwin') tray.on('click', showWindow)
  tray.on('double-click', showWindow)
  return tray
}
