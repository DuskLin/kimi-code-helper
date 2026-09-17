import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { parse, stringify } from 'yaml'

test('release manifests merge both Mac architectures and reject corrupt assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-release-'))
  try {
    const source = join(dir, 'input')
    for (const arch of ['x64', 'arm64']) {
      const platform = join(source, `mac-${arch}`)
      await mkdir(platform, { recursive: true })
      const url = `kimi-code-helper-0.2.0-mac-${arch}.zip`
      const data = Buffer.from(arch)
      await writeFile(join(platform, url), data)
      await writeFile(
        join(platform, 'latest-mac.yml'),
        stringify({
          version: '0.2.0',
          files: [
            { url, size: data.length, sha512: createHash('sha512').update(data).digest('base64') }
          ]
        })
      )
    }
    const run = (out: string) =>
      promisify(execFile)(process.execPath, [
        resolve('scripts/prepare-release.mjs'),
        source,
        join(dir, out)
      ])
    await run('valid')
    const manifest = parse(await readFile(join(dir, 'valid/latest-mac.yml'), 'utf8'))
    assert.equal(manifest.files.length, 2)
    assert.ok(manifest.files.some((file: { url: string }) => file.url.includes('arm64')))
    assert.ok(manifest.files.some((file: { url: string }) => file.url.includes('x64')))
    await writeFile(join(source, 'mac-arm64/kimi-code-helper-0.2.0-mac-arm64.zip'), 'corrupt')
    await assert.rejects(run('invalid'), /checksum/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
