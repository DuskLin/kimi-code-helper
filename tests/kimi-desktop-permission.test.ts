import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isKimiAppPermissionError,
  PERMISSION_HINT,
  withKimiPermissionGuide
} from '../src/main/services/kimi-desktop-permission'
import type { KimiDesktopState } from '../src/shared/kimi-desktop'

test('只识别 Kimi 应用内的 macOS 权限拒绝，不误导其他文件错误', () => {
  const error = {
    code: 'EPERM',
    path: '/Applications/Kimi Code.app/Contents/Resources/widget.js.tmp'
  }
  assert.equal(isKimiAppPermissionError(error, 'darwin'), true)
  assert.equal(isKimiAppPermissionError({ ...error, code: 'EACCES' }, 'darwin'), true)
  assert.equal(isKimiAppPermissionError(error, 'linux'), false)
  for (const path of [
    '/Users/me/Navo/gateway.json',
    '/Applications/Kimi Code.app.other/file',
    '/Applications/Kimi Code.app/../other/file'
  ]) {
    assert.equal(isKimiAppPermissionError({ ...error, path }, 'darwin'), false)
  }
  assert.equal(isKimiAppPermissionError({ ...error, code: 'ENOSPC' }, 'darwin'), false)
  assert.equal(isKimiAppPermissionError(new Error('EPERM'), 'darwin'), false)
})

test(
  '权限引导后刷新真实状态，不重试写入或报告成功',
  { skip: process.platform !== 'darwin' },
  async () => {
    const state: KimiDesktopState = {
      enabled: false,
      autoReapply: false,
      accountQuota: true,
      sessionStats: true,
      supported: true,
      installed: true,
      compatible: true,
      patched: true,
      version: '1.0.1',
      status: '已注入',
      error: ''
    }
    const events: string[] = []
    const result = await withKimiPermissionGuide(
      async () => {
        events.push('write')
        throw Object.assign(new Error('denied'), {
          code: 'EPERM',
          path: '/Applications/Kimi Code.app/Contents/Resources/widget.js.tmp'
        })
      },
      async () => {
        events.push('check')
        return state
      },
      async () => {
        events.push('guide')
      }
    )
    assert.deepEqual(events, ['write', 'guide', 'check'])
    assert.equal(result.enabled, false)
    assert.equal(result.error, PERMISSION_HINT)
  }
)

test('普通错误继续抛出，不弹权限引导', async () => {
  const error = new Error('页面结构不兼容')
  const unexpected = async (): Promise<never> => {
    throw new Error('不应调用')
  }
  await assert.rejects(
    withKimiPermissionGuide(
      async () => {
        throw error
      },
      unexpected,
      unexpected
    ),
    (actual) => actual === error
  )
})
