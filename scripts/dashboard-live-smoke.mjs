import { _electron as electron, chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'navo-live-dashboard-'))
const entry = join(directory, 'main.cjs')
await writeFile(
  entry,
  `
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'models.dev') return Response.json({});
  if (url.pathname.endsWith('/models')) return Response.json({ data: [{id:'kimi-for-coding'}] });
  if (url.pathname.endsWith('/usages')) return Response.json({ usage:{limit:100, remaining:64, resetTime:new Date(Date.now()+86400000).toISOString()},limits:[{window:{duration:300,timeUnit:'TIME_UNIT_MINUTE'},detail:{limit:100,remaining:81,resetTime:new Date(Date.now()+3600000).toISOString()}}] });
  throw new Error('Unexpected smoke request');
};
require(${JSON.stringify(resolve('out/main/index.js'))});
`
)
const env = { ...process.env, KIMI_HELPER_TEST_USER_DATA: directory }
delete env.ELECTRON_RUN_AS_NODE
let app, browser
try {
  app = await electron.launch({ args: [entry], env })
  const desktop = await app.firstWindow()
  await desktop.getByRole('button', { name: '远程仪表盘', exact: true }).waitFor()
  await desktop.evaluate(async () => {
    const state = await window.kimiHelper.getGateway()
    await window.kimiHelper.saveAccount({
      name: '实时验证账号',
      kind: 'api-key',
      provider: 'kimi',
      region: 'mainland-cn',
      secret: 'test-only-upstream-secret',
      enabled: true,
      memberships: [{ groupId: state.groups[0].id, priority: 1, weight: 1 }]
    })
  })
  const port = 52000 + Math.floor(Math.random() * 8000)
  const state = await desktop.evaluate(
    async (port) =>
      window.kimiHelper.saveDashboard({
        enabled: true,
        lan: true,
        port,
        tunnelMode: 'off',
        hostname: ''
      }),
    port
  )
  assert.equal(state.running, true)
  const originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  await desktop.evaluate(() => window.kimiHelper.copyDashboardCode())
  const code = await app.evaluate(({ clipboard }) => clipboard.readText())
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(state.localUrl)
  await page.getByRole('heading', { name: '登录额度仪表盘' }).waitFor()
  await page.getByLabel('访问码', { exact: true }).fill(code)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('link', { name: '查看实时验证账号详情' }).waitFor()
  assert.match(await page.locator('.account-card').innerText(), /81/)
  assert.equal(await page.getByText('Kimi 账号 A', { exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => document.cookie.includes('navo_dashboard')), false)
  await mkdir('artifacts/mobile', { recursive: true })
  await page.screenshot({ path: 'artifacts/mobile/live-login-390.png', fullPage: true })
  await desktop.getByRole('button', { name: '远程仪表盘', exact: true }).click()
  await desktop.getByRole('dialog', { name: '远程仪表盘' }).waitFor()
  await desktop.screenshot({ path: 'artifacts/mobile/desktop-sharing.png' })
  for (const url of state.lanUrls) {
    const result = await context.request.get(`${url}/api/snapshot`)
    assert.equal(result.status(), 401)
  }
  await desktop.evaluate(() => window.kimiHelper.rotateDashboardCode())
  await page.getByRole('button', { name: '刷新额度' }).click()
  await page.getByRole('heading', { name: '登录额度仪表盘' }).waitFor()
  assert.deepEqual(errors, [])
  if (process.env.TEST_PUBLIC_TUNNEL === '1') {
    await desktop.evaluate(
      async (port) =>
        window.kimiHelper.saveDashboard({
          enabled: true,
          lan: true,
          port,
          tunnelMode: 'quick',
          hostname: ''
        }),
      port
    )
    let live
    for (let i = 0; i < 50; i++) {
      live = await desktop.evaluate(() => window.kimiHelper.getDashboard())
      if (live.tunnel === 'connected') break
      if (live.tunnel === 'error') throw new Error(live.error)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    assert.equal(live.tunnel, 'connected', 'Quick tunnel must connect')
    await desktop.getByRole('button', { name: '复制', exact: true }).click()
    await desktop.getByText('公网地址已复制', { exact: true }).waitFor()
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), live.publicUrl)
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard)
    if (process.env.TEST_EXTERNAL_PROBE === '1') {
      console.log(`External probe URL: ${live.publicUrl}`)
      await new Promise((resolve) => setTimeout(resolve, 55000))
      console.log('External probe window finished; shutting down test tunnel.')
    } else {
      let publicStatus = 0
      for (let attempt = 0; attempt < 12; attempt++) {
        publicStatus = await app.evaluate(async ({ net }, url) => {
          try {
            return (
              await net.fetch(url + '/api/snapshot', {
                credentials: 'omit',
                cache: 'no-store',
                signal: AbortSignal.timeout(10000)
              })
            ).status
          } catch {
            return 0
          }
        }, live.publicUrl)
        if (publicStatus === 401) break
        if (attempt === 0) console.log('Waiting for quick hostname DNS/edge readiness…')
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
      assert.equal(publicStatus, 401)
      await desktop.evaluate(() => window.kimiHelper.copyDashboardCode())
      const currentCode = await app.evaluate(({ clipboard }) => clipboard.readText())
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard)
      const authenticated = await app.evaluate(
        async ({ net }, { url, code }) => {
          const login = await net.fetch(url + '/api/login', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', Origin: url },
            body: JSON.stringify({ code }),
            signal: AbortSignal.timeout(15000)
          })
          if (login.status !== 200) return { status: login.status, data: null }
          const response = await net.fetch(url + '/api/snapshot', {
            credentials: 'include',
            signal: AbortSignal.timeout(15000)
          })
          return { status: response.status, data: await response.json() }
        },
        { url: live.publicUrl, code: currentCode }
      )
      assert.equal(authenticated.status, 200)
      assert.equal(authenticated.data.accounts[0].name, '实时验证账号')
      assert.ok(!JSON.stringify(authenticated.data).includes('test-only-upstream-secret'))
      console.log(
        'Public quick tunnel: HTTPS login and live quota passed; unauthenticated data denied.'
      )
    }
  }
  console.log(
    'Passed: Electron integration, live quota/name, HTTPS browser login, HttpOnly cookie, LAN auth, revocation, no page errors.'
  )
} finally {
  if (browser) await browser.close()
  if (app) await app.close()
  await rm(directory, { recursive: true, force: true })
}
