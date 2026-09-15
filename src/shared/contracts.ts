export type Theme = 'light' | 'dark'

export interface AppSettings {
  theme: Theme
}

export interface AppInfo {
  version: string
  platform: string
  electron: string
}

export interface HelperApi {
  getAppInfo(): Promise<AppInfo>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
}

export const IPC = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save'
} as const
