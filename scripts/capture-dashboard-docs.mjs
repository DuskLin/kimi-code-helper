import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// Documentation assets come only from the explicit development fixtures.
// This process never opens Electron or reads the user's account configuration.
const output = resolve('artifacts/docs-dashboard')
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: resolve('vite.mobile.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false, open: false }
})
let browser
try {
  await server.listen()
  const port = server.httpServer.address().port
  browser = await chromium.launch({ headless: true })
  for (const [name, width, height, route] of [
    ['dashboard-phone', 390, 844, 'quota'],
    ['dashboard-phone-detail', 390, 844, 'account/kimi-a'],
    ['dashboard-ipad-portrait', 1024, 1366, 'quota'],
    ['dashboard-ipad-landscape', 1366, 1024, 'quota']
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce'
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const frozen = new Date('2026-09-18T09:41:08+08:00')
    await page.clock.install({ time: frozen })
    await page.clock.pauseAt(frozen)
    await page.goto(`http://127.0.0.1:${port}/mobile.html#${route}`)
    await page
      .getByRole('heading', { name: route === 'quota' ? '额度概览' : '账号详情', exact: true })
      .waitFor()
    await page.getByText('交互预览', { exact: true }).waitFor()
    assert.match(await page.locator('main').innerText(), /Kimi 账号 A/)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    if (route === 'quota') assert.equal(await page.locator('.account-card').count(), 4)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: resolve(output, `${name}.png`), animations: 'disabled' })
    assert.deepEqual(errors, [])
    console.log(`${name}.png: ${width} × ${height} CSS px, 2× capture`)
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  await server.close()
}
