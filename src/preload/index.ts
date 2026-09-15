import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type HelperApi } from '../shared/contracts'

// 仅暴露白名单业务方法，不允许渲染进程任意调用 IPC。
const api: HelperApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings)
}
contextBridge.exposeInMainWorld('kimiHelper', api)
