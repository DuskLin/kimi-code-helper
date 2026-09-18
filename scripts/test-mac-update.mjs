import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { stringify } from 'yaml'

if (process.platform !== 'darwin') {
  console.log('macOS integration test skipped on this platform')
  process.exit(0)
}
const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'kimi-update-integration-'))
let server
try {
  const staged = join(root, 'release/Navo.app')
  const installed = join(root, 'installed/Navo.app')
  await mkdir(join(staged, 'Contents/MacOS'), { recursive: true })
  await mkdir(join(root, 'user-data'))
  const marker = join(root, 'launched-new-version')
  const source = join(root, 'fixture.c')
  await writeFile(
    source,
    `#include <stdio.h>\nint main(void) { FILE *f = fopen(${JSON.stringify(marker)}, "w"); if (!f) return 1; fputs("0.2.0", f); fclose(f); return 0; }\n`
  )
  await exec('/usr/bin/clang', [source, '-o', join(staged, 'Contents/MacOS/fixture')])
  const plist = (version) =>
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.navo.app</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`
  await writeFile(join(staged, 'Contents/Info.plist'), plist('0.2.0'))
  await cp(staged, installed, { recursive: true })
  await writeFile(join(installed, 'Contents/Info.plist'), plist('0.1.0'))
  const name = `Navo-0.2.0-mac-${process.arch}.zip`
  const zip = join(root, name)
  await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', staged, zip])
  const data = await readFile(zip)
  const manifest = stringify({
    version: '0.2.0',
    files: [
      { url: name, size: data.length, sha512: createHash('sha512').update(data).digest('base64') }
    ]
  })
  let corrupt = true
  server = createServer((req, res) => {
    if (req.url?.split('?')[0] === '/latest-mac.yml') res.end(manifest)
    else if (req.url?.split('?')[0] === `/${name}`)
      res.end(corrupt ? Buffer.from('corrupt zip') : data)
    else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await writeFile(
    join(root, 'feed.yml'),
    stringify({
      provider: 'generic',
      url: `http://127.0.0.1:${server.address().port}`,
      updaterCacheDirName: 'test'
    })
  )
  const run = async () => {
    const env = { ...process.env, KIMI_UPDATE_FIXTURE: root }
    delete env.ELECTRON_RUN_AS_NODE
    if (corrupt) env.KIMI_UPDATE_CORRUPT = '1'
    else delete env.KIMI_UPDATE_CORRUPT
    return exec(electronPath, [resolve('artifacts/tests/tests/fixtures/mac-update-runner.js')], {
      env,
      timeout: 60_000
    })
  }
  await run()
  assert.match(await readFile(join(installed, 'Contents/Info.plist'), 'utf8'), /0\.1\.0/)
  assert.deepEqual(await readdir(join(root, 'installed')), ['Navo.app'])
  corrupt = false
  await run()
  // The detached helper waits for Electron to exit before replacing the fixture bundle.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await access(marker).then(
        () => true,
        () => false
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(await readFile(marker, 'utf8'), '0.2.0')
  assert.match(await readFile(join(installed, 'Contents/Info.plist'), 'utf8'), /0\.2\.0/)
  const backup = (await readdir(join(root, 'installed'))).find((name) =>
    name.startsWith('.navo-update-')
  )
  assert.ok(backup)
  assert.match(
    await readFile(join(root, 'installed', backup, 'previous.app/Contents/Info.plist'), 'utf8'),
    /0\.1\.0/
  )
  console.log(
    'Passed: real Electron download, checksum rejection, ZIP staging, app replacement, relaunch and retained backup (isolated fixture only).'
  )
} finally {
  server?.close()
  await rm(root, { recursive: true, force: true })
}
