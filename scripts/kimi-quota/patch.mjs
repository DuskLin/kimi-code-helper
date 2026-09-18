import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KimiDesktopIntegration } from '../../src/main/services/kimi-desktop-integration.ts'

// 与 Navo 设置共用补丁管理器，需要 Node 22.18+ 的 TypeScript 类型擦除支持。
const mode = process.argv[2]
if (!['install', 'uninstall', 'status'].includes(mode))
  throw new Error('使用：node scripts/kimi-quota/patch.mjs install|uninstall|status')
const integration = new KimiDesktopIntegration(
  join(homedir(), 'Library/Application Support/Navo'),
  await readFile(new URL('./widget.js', import.meta.url), 'utf8')
)
await integration.load()
const state =
  mode === 'status'
    ? integration.getState()
    : await integration.save({
        ...integration.getState(),
        enabled: mode === 'install',
        autoReapply: integration.getState().autoReapply
      })
console.log(JSON.stringify(mode === 'install' ? await integration.reapply() : state, null, 2))
