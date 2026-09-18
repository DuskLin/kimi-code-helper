import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'playwright'

const root = await mkdtemp(join(tmpdir(), 'navo-migration-ui-'))
let application
try {
  const paths = { source: join(root, 'source'), target: join(root, 'target') }
  await mkdir(join(paths.source, 'abc'), { recursive: true })
  await writeFile(
    join(paths.source, 'abc/task.json'),
    JSON.stringify({
      meta: {
        taskId: 'smoke',
        workspacePath: root,
        title: '迁移测试会话',
        createdAt: 1000,
        updatedAt: 2000
      },
      messages: [
        { role: 'user', content: '迁移这条消息', timestamp: 1000 },
        { role: 'assistant', content: '这是历史回复', timestamp: 2000 }
      ]
    })
  )
  const original = JSON.parse(await readFile(join(paths.source, 'abc/task.json'), 'utf8'))
  await writeFile(
    join(paths.source, 'abc/second.json'),
    JSON.stringify({
      ...original,
      meta: { ...original.meta, taskId: 'second', title: '同项目第二个会话' }
    })
  )
  const otherWorkspace = join(root, 'another', root.split('/').at(-1))
  await writeFile(
    join(paths.source, 'abc/third.json'),
    JSON.stringify({
      ...original,
      meta: {
        ...original.meta,
        taskId: 'third',
        title: '另一项目的会话',
        workspacePath: otherWorkspace
      }
    })
  )
  const entry = join(root, 'entry.cjs')
  // Only replace default test paths. Exercise the real renderer, preload, IPC and migration service.
  await writeFile(
    entry,
    `const { ipcMain } = require('electron');
    const handle = ipcMain.handle.bind(ipcMain);
    globalThis.migrationScanCount = 0;
    ipcMain.handle = (channel, listener) => handle(channel, channel === 'zcode:scan' ? (event, paths) => { globalThis.migrationScanCount++; return listener(event, paths ?? ${JSON.stringify(paths)}); } : listener);
    require(${JSON.stringify(resolve('out/main/index.js'))});`
  )
  const env = { ...process.env, NAVO_TEST_USER_DATA: join(root, 'navo') }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [entry], env })
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.getByRole('button', { name: '先体验一下' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '实验性功能', exact: true }).click()
  const section = page.getByRole('region', { name: 'Zcode 会话迁移' })
  await section.getByRole('button', { name: '扫描本机会话' }).click()
  await section.getByText('迁移测试会话', { exact: true }).waitFor()
  await section.locator('.migration-paths > summary').click()
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async (...args) => {
      globalThis.migrationDialogOptions = args.at(-1)
      return { canceled: true, filePaths: [] }
    }
  })
  await section.getByRole('button', { name: '选择Zcode 数据目录', exact: true }).click()
  assert.equal(
    await section.getByLabel('Zcode 数据目录', { exact: true }).inputValue(),
    paths.source
  )
  const options = await application.evaluate(() => globalThis.migrationDialogOptions)
  assert.equal(options.defaultPath, paths.source)
  assert.deepEqual(options.properties, ['openDirectory'])

  const all = section.getByRole('checkbox', { name: '选择全部会话', exact: true })
  const clearSelection = async () => {
    await all.check()
    await all.uncheck()
  }
  const project = section.getByRole('region', { name: `项目 ${root}`, exact: true })
  const projectAll = project.getByRole('checkbox', {
    name: `选择项目 ${root} 下的全部会话`,
    exact: true
  })
  const first = section.getByRole('checkbox', { name: '选择会话 迁移测试会话', exact: true })
  await all.check()
  await section.getByRole('button', { name: '迁移所选（3）' }).waitFor()
  await clearSelection()
  await projectAll.check()
  await section.getByRole('button', { name: '迁移所选（2）' }).waitFor()
  assert.equal(await all.evaluate((input) => input.indeterminate), true)
  await first.uncheck()
  assert.equal(await projectAll.evaluate((input) => input.indeterminate), true)
  await project.getByRole('button').click()
  assert.equal(await first.isVisible(), false)
  await all.check()
  await section.getByRole('button', { name: '迁移所选（3）' }).waitFor()
  await projectAll.uncheck()
  await section.getByRole('button', { name: '迁移所选（1）' }).waitFor()
  await clearSelection()
  await project.getByRole('button').click()
  await section.getByRole('button', { name: '选择未导入会话' }).click()
  await section.getByRole('button', { name: '迁移所选（3）' }).waitFor()
  await clearSelection()
  await first.check()
  await section.getByRole('button', { name: '迁移所选（1）' }).click()
  await section.getByText(/已导入 1 个，已存在 0 个，失败 0 个/).waitFor()
  const entryData = JSON.parse(await readFile(join(paths.target, 'session_index.jsonl'), 'utf8'))
  assert.match(
    await readFile(join(entryData.sessionDir, 'agents/main/wire.jsonl'), 'utf8'),
    /这是历史回复/
  )
  await section.getByRole('button', { name: '选择未导入会话' }).click()
  await section.getByRole('button', { name: '迁移所选（2）' }).waitFor()
  assert.equal(await first.isChecked(), false)
  await clearSelection()
  await first.check()
  await section.getByRole('button', { name: '迁移所选（1）' }).click()
  await section.getByText(/已导入 0 个，已存在 1 个，失败 0 个/).waitFor()

  assert.equal(
    await application.evaluate(() => globalThis.migrationScanCount),
    1,
    '迁移和重复导入不应触发全量重扫'
  )

  const chosenTarget = join(root, 'chosen-target')
  await mkdir(chosenTarget)
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, chosenTarget)
  await section.getByRole('button', { name: '选择Kimi Code 数据目录', exact: true }).click()
  await page.waitForFunction(
    (path) => document.querySelector('#migration-path-target')?.value === path,
    chosenTarget
  )
  assert.equal(await section.locator('.migration-browser').count(), 0)
  await section.getByRole('button', { name: '扫描本机会话' }).click()
  await section.getByText('迁移测试会话', { exact: true }).waitFor()
  await mkdir(resolve('artifacts'), { recursive: true })
  await section.screenshot({ path: resolve('artifacts/session-migration.png') })
  await page.setViewportSize({ width: 1280, height: 1080 })
  await page.screenshot({ path: resolve('artifacts/experimental-light.png') })
  await page.getByRole('button', { name: '深色模式', exact: true }).click()
  await page.screenshot({ path: resolve('artifacts/experimental-dark.png') })
  await page.setViewportSize({ width: 840, height: 1000 })
  await page.screenshot({ path: resolve('artifacts/experimental-narrow.png') })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true
  )

  assert.deepEqual(errors, [])
  console.log('Session migration UI smoke passed: scan, select, import and duplicate handling.')
} finally {
  await application?.close()
  await rm(root, { recursive: true, force: true })
}
