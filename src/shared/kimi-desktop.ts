export interface KimiDesktopPreferences {
  enabled: boolean
  autoReapply: boolean
  accountQuota: boolean
  sessionStats: boolean
}

export interface KimiDesktopState extends KimiDesktopPreferences {
  supported: boolean
  installed: boolean
  compatible: boolean
  patched: boolean
  version: string
  status: string
  error: string
}
