// Invoked only by scripts/test-mac-update.mjs inside a separate Electron process.
import assert from 'node:assert/strict'
import { app } from 'electron'
import { join } from 'node:path'
import { UnsignedMacUpdater } from '../../src/main/services/mac-updater'
import { UpdateService } from '../../src/main/services/updates'

const root = process.env.KIMI_UPDATE_FIXTURE
if (!root) throw new Error('Missing isolated updater fixture')
app.setPath('userData', join(root, 'user-data'))
app.setPath('exe', join(root, 'installed/Navo.app/Contents/MacOS/fixture'))
app.getVersion = () => '0.1.0'
Object.defineProperty(app, 'isPackaged', { value: true })

void app
  .whenReady()
  .then(async () => {
    const updater = new UnsignedMacUpdater()
    // Isolate the cache without changing production paths or exposing a configurable update source.
    Object.defineProperty(updater, 'app', {
      value: {
        version: '0.1.0',
        name: 'updater-fixture',
        isPackaged: true,
        appUpdateConfigPath: join(root, 'feed.yml'),
        userDataPath: join(root, 'user-data'),
        baseCachePath: join(root, 'cache'),
        whenReady: () => app.whenReady()
      }
    })
    updater.updateConfigPath = join(root, 'feed.yml')
    const service = new UpdateService(
      updater,
      {
        version: '0.1.0',
        enabled: true,
        canInstall: true,
        reason: ''
      },
      async () => {}
    )
    await service.check()
    if (process.env.KIMI_UPDATE_CORRUPT) {
      assert.equal(service.get().status, 'error')
      app.exit(0)
      return
    }
    assert.equal(service.get().status, 'downloaded')
    await service.install()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
