import { spawn } from 'node:child_process'
import { once } from 'node:events'
import electron from 'electron'
import { resolveConfig } from 'electron-vite'
import { build, createServer, mergeConfig } from 'vite'

// 复用 electron-vite 的构建配置，但串行管理 Electron 的退出和重启。
// 内置 --watch 会在旧进程完全退出前启动新进程，可能撞上应用的单实例锁。
process.env.NODE_ENV_ELECTRON_VITE = 'development'
const watchers = []
let renderer
let child
let closing = false
let restarting = Promise.resolve()
let reloadTimer

async function stopChild(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit')
  process.kill('SIGTERM')
  // 仅处理本启动器创建的开发进程；退出卡住时不让重复实例占用本地端口。
  const timeout = setTimeout(() => process.kill('SIGKILL'), 3000)
  timeout.unref()
  try {
    await exited
  } finally {
    clearTimeout(timeout)
  }
}

function launch() {
  if (closing) return
  const env = { ...process.env, ELECTRON_RENDERER_URL: renderer.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  const next = spawn(electron, ['.'], { stdio: 'inherit', env })
  child = next
  console.log(`Electron 已启动（PID ${next.pid}）`)
  next.once('error', (error) => {
    console.error('Electron 启动失败：', error.message)
    void shutdown(1)
  })
  next.once('exit', (code) => {
    if (child === next && !closing) void shutdown(code ?? 0)
  })
}

function restart() {
  clearTimeout(reloadTimer)
  // 合并同一次保存产生的多个构建事件，且等待旧进程退出后再启动。
  reloadTimer = setTimeout(() => {
    restarting = restarting
      .then(async () => {
        if (closing) return
        const previous = child
        child = undefined
        await stopChild(previous)
        launch()
      })
      .catch((error) => {
        console.error('开发重启失败：', error.message)
        void shutdown(1)
      })
  }, 100)
}

async function watch(config, changed) {
  const watcher = await build(mergeConfig(config, { build: { watch: {} } }))
  watchers.push(watcher)
  await new Promise((resolve, reject) => {
    let initial = true
    let failed = false
    watcher.on('event', (event) => {
      if (event.code === 'START') failed = false
      if (event.code === 'ERROR') {
        failed = true
        console.error(event.error.message)
        if (initial) reject(event.error)
      }
      if (event.code === 'END' && !failed) {
        if (initial) {
          initial = false
          resolve()
        } else changed()
      }
    })
  })
}

async function shutdown(code = 0) {
  if (closing) return
  closing = true
  clearTimeout(reloadTimer)
  try {
    await restarting
    await stopChild(child)
    await Promise.all(watchers.map((watcher) => watcher.close()))
    await renderer?.close()
  } finally {
    process.exit(code)
  }
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

try {
  const { config } = await resolveConfig({}, 'serve', 'development')
  if (!config?.main || !config.preload || !config.renderer) throw new Error('开发构建配置不完整')
  await watch(config.main, restart)
  await watch(config.preload, () => renderer?.ws.send({ type: 'full-reload' }))
  renderer = await createServer(config.renderer)
  await renderer.listen()
  renderer.printUrls()
  launch()
} catch (error) {
  console.error('开发服务启动失败：', error.message)
  await shutdown(1)
}
