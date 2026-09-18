import { isAbsolute, relative, sep } from 'node:path'
import type { KimiDesktopState } from '../../shared/kimi-desktop'
import { KIMI_DESKTOP_APP } from './kimi-desktop-integration'

export const APP_MANAGEMENT_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles'
export const PERMISSION_HINT =
  '请在“系统设置 → 隐私与安全性 → App 管理”中允许 Navo 修改其他应用，完全退出并重新打开 Navo 后重试。若已授权仍失败，请检查 Kimi Code 的安装目录权限。'

export function isKimiAppPermissionError(error: unknown, platform = process.platform): boolean {
  if (platform !== 'darwin' || !error || typeof error !== 'object') return false
  const { code, path } = error as NodeJS.ErrnoException
  if ((code !== 'EPERM' && code !== 'EACCES') || typeof path !== 'string') return false
  const child = relative(KIMI_DESKTOP_APP, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

// 仅用户主动操作时提示；后台检查不弹窗，也不自动重试写入。
export async function withKimiPermissionGuide(
  run: () => Promise<KimiDesktopState>,
  check: () => Promise<KimiDesktopState>,
  guide: () => Promise<void>
): Promise<KimiDesktopState> {
  try {
    return await run()
  } catch (error) {
    if (!isKimiAppPermissionError(error)) throw error
    await guide()
    return { ...(await check()), error: PERMISSION_HINT }
  }
}
