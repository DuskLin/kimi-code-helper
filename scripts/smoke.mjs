import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'

const userData = await mkdtemp(join(tmpdir(), 'kimi-helper-smoke-'))
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const errors = []
let application
const forwarded = []
let fiveHourRemaining = 40
let weeklyRemaining = 80
const upstream = createServer((req, res) => {
  if (req.url === '/coding/v1/usages') {
    assert.equal(req.headers['user-agent'], 'KimiCLI/1.6')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        parallel: { limit: '30' },
        usage: {
          limit: '100',
          used: String(100 - weeklyRemaining),
          remaining: String(weeklyRemaining),
          resetTime: '2030-01-08T00:00:00Z'
        },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: {
              limit: '50',
              used: String(50 - fiveHourRemaining),
              remaining: String(fiveHourRemaining),
              resetTime: '2030-01-01T05:00:00Z'
            }
          }
        ]
      })
    )
    return
  }
  if (req.url === '/coding/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'kimi-for-coding' }, { id: 'k3' }] }))
    return
  }
  forwarded.push(req.headers.authorization)
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-request-id': '6adf4190-2959-4444-878c-454c7a6673ad'
  })
  res.end(
    JSON.stringify({
      id: 'smoke-completion',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 800 }
      },
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    })
  )
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port
// 仅测试入口注入传输层，生产代码始终使用固定官方地址。
const testEntry = join(userData, 'smoke-main.cjs')
await writeFile(
  testEntry,
  `
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (['api.kimi.com', 'api.kimi.ai'].includes(url.hostname)) {
      return realFetch('http://127.0.0.1:${upstreamPort}' + url.pathname + url.search, init);
    }
    return realFetch(input, init);
  };
  require(${JSON.stringify(resolve('out/main/index.js'))});
`
)
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const gatewayPort = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))

async function launch() {
  const env = { ...process.env, KIMI_HELPER_TEST_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [testEntry], env })
  const page = await application.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page
    .locator('.app-status')
    .filter({ hasText: /网关运行中|网关已停止/ })
    .waitFor()
  await page.getByRole('button', { name: '网关设置', exact: true }).waitFor()
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
  await page.screenshot({ path: join(artifacts, 'empty.png') })

  // 模拟旧主进程没有新接口：显示可执行的提示，并在接口恢复后清除错误。
  const initialGateway = await page.evaluate(() => window.kimiHelper.getGateway())
  await application.evaluate(({ ipcMain }) => ipcMain.removeHandler('gateway:get'))
  await page.reload()
  await page.getByRole('heading', { name: '网关服务尚未就绪', exact: true }).waitFor()
  await page.getByText(/仅刷新窗口无法更新后台/).waitFor()
  await application.evaluate(({ ipcMain }, snapshot) => {
    ipcMain.handle('gateway:get', () => snapshot)
  }, initialGateway)
  await page.getByRole('button', { name: '网关设置', exact: true }).waitFor()
  assert.equal(await page.getByRole('alert').count(), 0)
  await application.close()
  application = undefined
  page = await launch()

  assert.equal(await page.getByRole('tablist', { name: '网关管理' }).count(), 0)
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.getByRole('tablist', { name: '网关管理' }).waitFor()
  await page.getByRole('button', { name: '返回概览', exact: true }).click()
  assert.equal(await page.getByRole('tablist', { name: '网关管理' }).count(), 0)
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: '分组管理' }).count(), 0)
  for (const name of ['开发账号 A', '开发账号 B']) {
    await page.getByRole('button', { name: '添加账号', exact: true }).click()
    assert.equal(
      await page
        .getByRole('dialog')
        .getByText(/OAuth|Refresh Token|浏览器授权/)
        .count(),
      0
    )
    assert.equal(await page.getByLabel('接入方式', { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => typeof window.kimiHelper.startLogin), 'undefined')
    await page.getByLabel('账号名称', { exact: true }).fill(name)
    await page.getByLabel(/^API Key/).fill(name.endsWith('A') ? 'smoke-secret-a' : 'smoke-secret-b')
    assert.equal(
      await page.getByLabel('上游 Base URL', { exact: true }).inputValue(),
      'https://api.kimi.com/coding/v1'
    )
    assert.equal(
      await page.getByLabel('上游 Base URL', { exact: true }).getAttribute('readonly'),
      ''
    )
    await page.getByLabel('API Key', { exact: true }).press('Tab')
    await page.waitForFunction(() =>
      document.querySelector('textarea[aria-label="可用模型"]')?.value.includes('kimi-for-coding')
    )
    assert.equal(await page.getByLabel('账号并发上限', { exact: true }).inputValue(), '30')
    if (name === '开发账号 A') {
      await page.getByLabel('账号并发上限', { exact: true }).fill('5')
      const scrollBody = page.locator('.modal-scroll-body')
      assert.equal(await scrollBody.evaluate((el) => getComputedStyle(el).scrollbarWidth), 'none')
      assert.equal(await scrollBody.evaluate((el) => el.offsetWidth - el.clientWidth), 0)
      await scrollBody.focus()
      await scrollBody.press('End')
      // 等待 End 键的原生滚动动画结束，再读取滑块位置进行拖动。
      await page.waitForFunction(() => {
        const el = document.querySelector('.modal-scroll-body')
        return el.scrollTop > 0 && el.scrollHeight - el.clientHeight - el.scrollTop < 1
      })
      await page.waitForFunction(() =>
        document.querySelector('.modal-scroll-track').classList.contains('is-visible')
      )
      // 滑块可拖拽，滚动停止后自动隐藏；表单状态保持。
      const thumb = await page.locator('.modal-scroll-thumb').boundingBox()
      const track = await page.locator('.modal-scroll-track').boundingBox()
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
      await page.mouse.down()
      await page.mouse.move(track.x + track.width / 2, track.y + 2, { steps: 5 })
      await page.mouse.up()
      await page.mouse.move(100, 100)
      await page.waitForFunction(() => document.querySelector('.modal-scroll-body').scrollTop < 10)
      await page.waitForFunction(
        () => !document.querySelector('.modal-scroll-track').classList.contains('is-visible')
      )
      assert.equal(await page.getByLabel('账号名称', { exact: true }).inputValue(), name)
      assert.equal(await page.getByLabel('账号并发上限', { exact: true }).inputValue(), '5')
    }
    assert.equal(await page.getByLabel('可用模型', { exact: true }).getAttribute('readonly'), '')
    await page.getByText('剩余 80 / 100', { exact: true }).waitFor()
    await page.getByText('剩余 40 / 50', { exact: true }).waitFor()
    await page.getByRole('button', { name: '保存账号', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByText(name, { exact: true }).waitFor()
  }
  const accountSnapshot = await page.evaluate(() => window.kimiHelper.getGateway())
  assert.equal(accountSnapshot.accounts.length, 2)
  assert.equal(accountSnapshot.accounts.find((a) => a.name === '开发账号 A').maxConcurrency, 5)
  assert.ok(!JSON.stringify(accountSnapshot).includes('smoke-secret'))
  const encrypted = await readFile(join(userData, 'gateway.json'), 'utf8')
  assert.ok(!encrypted.includes('smoke-secret'))
  assert.ok(!encrypted.includes('开发账号'))
  assert.equal(typeof JSON.parse(encrypted).encrypted, 'string')

  await page.getByRole('button', { name: '网关设置', exact: true }).click()
  await page.getByLabel(/^监听端口/).fill(String(gatewayPort))
  await page.getByLabel('打开应用时自动启动网关', { exact: true }).check()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '启动网关', exact: true }).click()
  await page.getByRole('button', { name: '停止网关', exact: true }).waitFor()
  const originalClipboard = await application.evaluate(({ clipboard }) => clipboard.readText())
  let groupKey
  try {
    await page.getByRole('button', { name: '复制密钥', exact: true }).click()
    await page.getByText('已复制到剪贴板', { exact: true }).waitFor()
    groupKey = await application.evaluate(({ clipboard }) => clipboard.readText())
    assert.match(groupKey, /^[a-f0-9]{64}$/)
    await page.getByRole('button', { name: '复制 URL', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('.statusbar-copy .lucide-check') !== null
    )
    assert.equal(
      await application.evaluate(({ clipboard }) => clipboard.readText()),
      `http://127.0.0.1:${gatewayPort}/v1`
    )
    await page.getByRole('button', { name: '复制 Key', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('[aria-label="复制 Key"] .lucide-check') !== null
    )
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), groupKey)
  } finally {
    await application.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      originalClipboard
    )
  }
  for (let i = 0; i < 4; i++) {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${groupKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-for-coding',
        messages: [{ role: 'user', content: 'smoke' }]
      })
    })
    assert.equal(response.status, 200)
    await response.json()
  }
  assert.deepEqual(forwarded, [
    'Bearer smoke-secret-b',
    'Bearer smoke-secret-b',
    'Bearer smoke-secret-b',
    'Bearer smoke-secret-b'
  ])
  await page.waitForFunction(
    async () => (await window.kimiHelper.getGateway()).requests.length === 4
  )
  await page.getByRole('button', { name: '返回概览', exact: true }).click()
  await page.getByText('4,400', { exact: true }).waitFor()
  const autoRefresh = page.getByRole('button', { name: '切换自动刷新间隔', exact: true })
  for (const label of ['5s', '15s', '30s']) {
    assert.equal(await autoRefresh.textContent(), label)
    await autoRefresh.click()
  }
  assert.equal(await autoRefresh.textContent(), '5s')
  await page.locator('.workspace').evaluate((el) => el.scrollTo(0, 0))
  await page.screenshot({ path: join(artifacts, 'usage.png') })
  const heatmap = page.getByRole('region', { name: '每日消耗热力图', exact: true })
  await heatmap.locator('.heatmap-day.is-today').waitFor()
  assert.equal(await heatmap.locator('.heatmap-day').count(), 112)
  await heatmap.locator('.heatmap-day.is-today').click()
  await heatmap.getByText('kimi-for-coding', { exact: true }).waitFor()
  assert.match(await heatmap.locator('.heatmap-day-summary').textContent(), /4 次请求.*4,400/)
  await heatmap.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifacts, 'heatmap.png') })
  await heatmap.getByRole('button', { name: '收起', exact: true }).click()
  const quotaCard = page.getByRole('article', { name: '开发账号 A 额度', exact: true })
  await quotaCard.getByText('5h', { exact: true }).waitFor()
  await quotaCard.getByText('7D', { exact: true }).waitFor()
  assert.equal(
    await page.getByRole('region', { name: '已关联账号额度' }).getByRole('article').count(),
    2
  )
  assert.equal(
    await quotaCard.getByRole('progressbar', { name: '5h 剩余额度比例' }).getAttribute('value'),
    '80'
  )
  await quotaCard.getByTitle('剩余 40 / 50', { exact: true }).waitFor()
  await quotaCard.getByTitle('剩余 80 / 100', { exact: true }).waitFor()
  fiveHourRemaining = 35
  weeklyRemaining = 60
  await quotaCard.getByRole('button', { name: '刷新 开发账号 A 额度', exact: true }).click()
  await page.getByRole('button', { name: '刷新 开发账号 B 额度', exact: true }).click()
  await quotaCard.getByTitle('剩余 35 / 50', { exact: true }).waitFor()
  await quotaCard.getByTitle('剩余 60 / 100', { exact: true }).waitFor()
  assert.equal(
    await quotaCard.getByRole('progressbar', { name: '5h 剩余额度比例' }).getAttribute('value'),
    '70'
  )
  assert.equal(
    await quotaCard.getByRole('progressbar', { name: '7D 剩余额度比例' }).getAttribute('value'),
    '60'
  )
  fiveHourRemaining = 0
  await quotaCard.getByRole('button', { name: '刷新 开发账号 A 额度', exact: true }).click()
  await quotaCard.getByTitle('剩余 0 / 50', { exact: true }).waitFor()
  assert.equal(
    await quotaCard.getByRole('progressbar', { name: '5h 剩余额度比例' }).getAttribute('value'),
    '0'
  )

  await page.getByText('已复制到剪贴板', { exact: true }).waitFor({ state: 'hidden' })
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
  await page.getByRole('button', { name: '停止网关', exact: true }).waitFor()
  const restoredGateway = await page.evaluate(() => window.kimiHelper.getGateway())
  assert.equal(restoredGateway.accounts.length, 2)
  assert.equal(restoredGateway.groups.length, 1)
  assert.equal(restoredGateway.settings.port, gatewayPort)
  assert.equal(restoredGateway.accounts.find((a) => a.name === '开发账号 A').maxConcurrency, 5)
  assert.equal(restoredGateway.accounts.find((a) => a.name === '开发账号 A').concurrencyOverride, 5)
  assert.equal(await page.getByRole('tablist', { name: '网关管理' }).count(), 0)
  await page.getByRole('button', { name: '账号管理', exact: true }).click()
  await page.getByText('开发账号 A', { exact: true }).waitFor()
  // 使用重启前复制的密钥验证持久化后的真实转发。
  const restoredResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
    headers: { authorization: `Bearer ${groupKey}` }
  })
  assert.equal(restoredResponse.status, 200)
  await restoredResponse.text()
  await page.getByRole('tab', { name: '请求记录' }).click()
  await page.getByText('模型列表', { exact: true }).waitFor()
  // 重启后旧请求仍可查看；新增请求通过 10 条游标分页访问。
  assert.equal(restoredGateway.requests.length, 4)
  for (let i = 0; i < 11; i++) {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${groupKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-for-coding', input: 'smoke' })
    })
    assert.equal(response.status, 200)
    await response.text()
  }
  await page.getByText('共 16 条', { exact: true }).waitFor()
  assert.equal(await page.getByRole('row').count(), 11)
  await page
    .getByText('requestId: 6adf4190-2959-4444-878c-454c7a6673ad', { exact: true })
    .first()
    .waitFor()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByText('第 2 页', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 6)
  await page.getByRole('button', { name: '上一页', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 10)
  await page.screenshot({ path: join(artifacts, 'requests.png') })
  await page.getByRole('tab', { name: /账号池/ }).click()
  const row = page.getByRole('row').filter({ hasText: '开发账号 B' })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('账号名称', { exact: true }).fill('备用账号 B')
  await page.getByLabel('账号并发上限', { exact: true }).fill('7')
  await page.getByRole('button', { name: '恢复自动', exact: true }).click()
  assert.equal(await page.getByLabel('账号并发上限', { exact: true }).inputValue(), '30')
  await page.getByLabel('账号并发上限', { exact: true }).fill('7')
  await page.screenshot({ path: join(artifacts, 'account-editor.png') })
  await page.getByRole('button', { name: '保存账号', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByText('备用账号 B', { exact: true }).waitFor()
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.kimiHelper.getGateway()).accounts.find((a) => a.name === '备用账号 B')
          .maxConcurrency
    ),
    7
  )
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
  await page.getByRole('button', { name: '停止网关', exact: true }).click()
  await page.getByRole('button', { name: '启动网关', exact: true }).waitFor()
  await page.getByRole('button', { name: '复制 URL', exact: true }).waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  console.log(
    '通过：真实 Electron、进程隔离、主题、统一账号管理、系统加密存储、真实 HTTP 负载均衡、重启恢复与自动启动、请求记录及最小窗口布局。'
  )
} finally {
  if (application) await application.close()
  await new Promise((resolve) => {
    upstream.close(resolve)
    upstream.closeAllConnections()
  })
  await rm(userData, { recursive: true, force: true })
}
