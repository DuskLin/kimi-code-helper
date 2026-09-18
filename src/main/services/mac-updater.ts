import { app } from 'electron'
import { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { macInstallScript, validateMacArchive, validateMacExecutable } from './mac-install'

const exec = promisify(execFile)

// Use GitHub discovery, version selection, cache and SHA-512 verification from electron-updater.
// Replace Squirrel.Mac's certificate-dependent installation with a local bundle replacement.
export class UnsignedMacUpdater extends AppUpdater {
  private prepared?: { target: string; staged: string; directory: string }

  constructor() {
    super(undefined)
  }

  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { info, provider } = options.updateInfoAndProvider
    const expected = `Navo-${info.version}-mac-${process.arch}.zip`
    const file = provider.resolveFiles(info).find((entry) => entry.info.url === expected)
    if (!file || !file.info.sha512) throw new Error('发布版本缺少当前架构的更新文件')
    const executor = new ElectronHttpExecutor()
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo: file,
      downloadUpdateOptions: options,
      task: (destination, downloadOptions) =>
        executor.download(file.url, destination, downloadOptions),
      done: async (event) => {
        if (this.prepared) {
          await rm(this.prepared.directory, { recursive: true, force: true })
          this.prepared = undefined
        }
        const target = await realpath(resolve(dirname(app.getPath('exe')), '../..'))
        const parent = dirname(target)
        await access(parent, constants.W_OK)
        await access(target, constants.W_OK)
        if (!target.endsWith('.app') || target.startsWith('/Volumes/'))
          throw new Error('请先将应用安装到 Applications 后再更新')
        const directory = await mkdtemp(join(parent, '.navo-update-'))
        try {
          const { stdout } = await exec('/usr/bin/unzip', ['-Z1', event.downloadedFile], {
            maxBuffer: 16 * 1024 * 1024
          })
          validateMacArchive(stdout.trimEnd().split('\n'))
          await exec('/usr/bin/ditto', ['-x', '-k', event.downloadedFile, directory])
          const staged = join(directory, 'Navo.app')
          const plist = join(staged, 'Contents/Info.plist')
          const readKey = async (key: string) =>
            (
              await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
            ).stdout.trim()
          if (
            (await readKey('CFBundleIdentifier')) !== 'dev.navo.app' ||
            (await readKey('CFBundleShortVersionString')) !== info.version
          )
            throw new Error('更新应用的标识或版本不匹配')
          const executable = await readKey('CFBundleExecutable')
          if (!executable || executable.includes('/') || executable === '..')
            throw new Error('更新应用的执行文件无效')
          const binary = await open(join(staged, 'Contents/MacOS', executable), 'r')
          try {
            const header = Buffer.alloc(4096)
            const { bytesRead } = await binary.read(header, 0, header.length, 0)
            validateMacExecutable(header.subarray(0, bytesRead), process.arch)
          } finally {
            await binary.close()
          }
          this.prepared = { target, staged, directory }
          this.dispatchUpdateDownloaded(event)
        } catch (error) {
          await rm(directory, { recursive: true, force: true })
          throw error
        }
      }
    })
  }

  async quitAndInstall(): Promise<void> {
    if (!this.prepared) throw new Error('更新尚未准备完成')
    const { target, staged, directory } = this.prepared
    const script = join(directory, 'install.sh')
    await writeFile(script, macInstallScript, { mode: 0o700 })
    const log = await open(join(app.getPath('userData'), 'update-install.log'), 'w', 0o600)
    try {
      const child = spawn(
        '/bin/sh',
        [
          script,
          String(process.pid),
          target,
          staged,
          join(directory, 'previous.app'),
          '/usr/bin/open'
        ],
        {
          detached: true,
          stdio: ['ignore', log.fd, log.fd]
        }
      )
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
    } finally {
      await log.close()
    }
    app.quit()
  }
}
