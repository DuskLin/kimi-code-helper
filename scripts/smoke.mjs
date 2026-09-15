import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const userData = await mkdtemp(join(tmpdir(), 'kimi-helper-smoke-'))
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const errors = []
let application

async function launch() {
  const env = { ...process.env, KIMI_HELPER_TEST_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [resolve('.')], env })
  const page = await application.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByText('工作空间已就绪', { exact: true }).waitFor()
  return page
}

try {
  let page = await launch()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration
    }
  })
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  await page.screenshot({ path: join(artifacts, 'light.png') })

  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    'rgb(21, 23, 25)'
  )
  assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark')
  assert.deepEqual(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')), {
    theme: 'dark'
  })
  await page.screenshot({ path: join(artifacts, 'dark.png') })

  // 无效 IPC 输入应被主进程拒绝，不能污染已保存的主题。
  const rejected = await page.evaluate(async () => {
    try {
      await window.kimiHelper.saveSettings({ theme: 'invalid' })
      return false
    } catch {
      return true
    }
  })
  assert.equal(rejected, true)
  await application.close()
  application = undefined

  page = await launch()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  await page.getByRole('button', { name: '浅色模式', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    'rgb(248, 249, 250)'
  )
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(640, 440)
  )
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    true
  )
  await page.screenshot({ path: join(artifacts, 'compact.png') })
  assert.deepEqual(errors, [])
  console.log(
    '通过：真实 Electron 启动、进程隔离、深浅主题切换、重启后恢复、无效输入拒绝及最小窗口布局。'
  )
} finally {
  if (application) await application.close()
  await rm(userData, { recursive: true, force: true })
}
