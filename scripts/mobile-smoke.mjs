import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const base = process.env.MOBILE_PREVIEW_URL || 'http://127.0.0.1:5180/mobile.html'
await mkdir('artifacts/mobile', { recursive: true })
try {
  await page.goto(base)
  for (const [width, height, columns, bottomNav] of [
    [390, 844, 1, true],
    [844, 390, 2, false],
    [768, 1024, 2, false],
    [1024, 768, 3, false],
    [820, 1180, 2, false],
    [1180, 820, 3, false]
  ]) {
    await page.setViewportSize({ width, height })
    await page.goto(`${base}#quota`)
    await page.locator('.account-card').first().waitFor()
    assert.equal(
      await page
        .locator('.account-grid')
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
      columns,
      `Orientation layout ${width}x${height}`
    )
    assert.equal(await page.locator('.bottom-nav').isVisible(), bottomNav)
    if (width === 844 && height === 390) {
      const bounds = await page.locator('.account-card .meter strong').first().boundingBox()
      assert.ok(
        bounds && bounds.y + bounds.height < height,
        'Phone landscape must show quota in the first viewport'
      )
    }
    for (const route of [
      'quota',
      'account/kimi-a',
      'account/deepseek',
      'account/go',
      'usage',
      'status'
    ]) {
      await page.goto(`${base}#${route}`)
      await page.locator('main h1').waitFor()
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `Orientation overflow at ${width}x${height} / ${route}`
      )
      if (route.startsWith('account/')) {
        assert.equal(
          await page
            .locator('.detail-grid')
            .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
          width < 700 ? 1 : 2
        )
      }
    }
    await page.goto(`${base}#quota`)
    await page.screenshot({
      path: `artifacts/mobile/orientation-${width}x${height}.png`,
      fullPage: false
    })
  }
  for (const [width, columns] of [
    [320, 1],
    [390, 1],
    [768, 2],
    [1280, 3],
    [1600, 4]
  ]) {
    await page.setViewportSize({ width, height: 900 })
    await page.locator('.account-card').first().waitFor()
    assert.equal(
      await page
        .locator('.account-grid')
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
      columns
    )
    for (const route of [
      'quota',
      'account/kimi-a',
      'account/deepseek',
      'account/go',
      'usage',
      'status'
    ]) {
      await page.goto(`${base}#${route}`)
      await page.locator('main h1').waitFor()
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `Overflow at ${width}px / ${route}`
      )
    }
    await page.goto(`${base}#quota`)
    const cards = await page.locator('.account-card').evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect()
        return { top: rect.top, height: rect.height }
      })
    )
    for (const card of cards) {
      for (const sibling of cards.filter((other) => Math.abs(other.top - card.top) < 1)) {
        assert.ok(
          Math.abs(card.height - sibling.height) < 1,
          `Cards must have equal height in each row at ${width}px`
        )
      }
    }
    await page.getByRole('button', { name: '查看 11 小时前用量', exact: true }).click()
    const dot = await page.locator('.chart-point').boundingBox()
    assert.ok(
      dot && Math.abs(dot.width - dot.height) < 0.1 && dot.width === 12,
      `Chart dot must stay round at ${width}px`
    )
    assert.match(await page.locator('.chart-curve').getAttribute('d'), / C /)
    assert.equal(
      await page.locator('.chart-curve').getAttribute('vector-effect'),
      'non-scaling-stroke'
    )
    if ([390, 1280, 1600].includes(width))
      await page.screenshot({ path: `artifacts/mobile/overview-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'DeepSeek', exact: true }).click()
  assert.equal(await page.locator('.account-card').count(), 1)
  await page.getByRole('link', { name: '查看DeepSeek详情' }).click()
  await page.locator('.balance-hero').waitFor()
  assert.match(await page.locator('.balance-hero').innerText(), /128\.60/)
  await page.getByRole('link', { name: '返回额度概览' }).click()
  await page.getByRole('button', { name: '全部' }).click()
  await page.getByRole('link', { name: '查看Kimi 账号 A详情' }).click()
  await page.locator('.quota-ring').waitFor()
  assert.match(await page.locator('.quota-ring').innerText(), /72/)
  await page.screenshot({ path: 'artifacts/mobile/detail-390.png', fullPage: true })
  await page.locator('.bottom-nav').getByRole('link', { name: '状态' }).click()
  await page.getByRole('button', { name: '模拟连接中断' }).click()
  assert.match(await page.getByRole('status').innerText(), /数据可能已过期/)
  assert.equal(await page.getByRole('button', { name: '刷新示例数据' }).isDisabled(), true)
  await page.getByRole('button', { name: '恢复演示连接' }).click()
  assert.equal(await page.getByRole('button', { name: '刷新示例数据' }).isEnabled(), true)
  await page.getByRole('button', { name: '切换深色模式' }).click()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  await page.locator('.bottom-nav').getByRole('link', { name: '额度' }).click()
  await page.screenshot({ path: 'artifacts/mobile/dark-390.png', fullPage: true })
  assert.deepEqual(errors, [])
  console.log(
    'Passed: 5 viewport sizes + 6 phone/tablet orientations × 6 routes, responsive columns/navigation, provider filter, detail navigation, disconnect/reconnect, dark mode, no page errors.'
  )
} finally {
  await browser.close()
}
