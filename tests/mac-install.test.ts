import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  macInstallScript,
  validateMacArchive,
  validateMacExecutable
} from '../src/main/services/mac-install'

test('Mac executable architecture validation accepts thin and universal binaries', () => {
  const thin = Buffer.alloc(32)
  thin.writeUInt32LE(0xfeedfacf, 0)
  thin.writeUInt32LE(0x0100000c, 4)
  validateMacExecutable(thin, 'arm64')
  assert.throws(() => validateMacExecutable(thin, 'x64'))
  const fat = Buffer.alloc(48)
  fat.writeUInt32BE(0xcafebabe, 0)
  fat.writeUInt32BE(2, 4)
  fat.writeUInt32BE(0x01000007, 8)
  fat.writeUInt32BE(0x0100000c, 28)
  validateMacExecutable(fat, 'x64')
  validateMacExecutable(fat, 'arm64')
  assert.throws(() => validateMacExecutable(Buffer.from('broken'), 'arm64'))
})

test('Mac archives reject absolute paths, traversal and other bundles', () => {
  validateMacArchive(['Kimi Code Helper.app/', 'Kimi Code Helper.app/Contents/Info.plist'])
  for (const entries of [
    [],
    ['/tmp/evil'],
    ['Kimi Code Helper.app/../../evil'],
    ['Other.app/'],
    ['Kimi Code Helper.app/..\\evil']
  ])
    assert.throws(() => validateMacArchive(entries))
})

for (const success of [true, false]) {
  test(
    `Mac replacement ${success ? 'installs and keeps backup' : 'rolls back if launch fails'}`,
    { skip: process.platform === 'win32' },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "kimi update '$ test-"))
      try {
        const target = join(dir, 'Kimi Code Helper.app')
        const staged = join(dir, 'staged.app')
        const backup = join(dir, 'previous.app')
        for (const path of [target, staged]) await mkdir(path)
        await writeFile(join(target, 'version'), 'old')
        await writeFile(join(staged, 'version'), 'new')
        const script = join(dir, 'install.sh')
        await writeFile(script, macInstallScript)
        const run = promisify(execFile)('/bin/sh', [
          script,
          '999999999',
          target,
          staged,
          backup,
          success ? '/usr/bin/true' : '/usr/bin/false'
        ])
        if (success) await run
        else await assert.rejects(run)
        assert.equal(await readFile(join(target, 'version'), 'utf8'), success ? 'new' : 'old')
        if (success) assert.equal(await readFile(join(backup, 'version'), 'utf8'), 'old')
        else await assert.rejects(access(backup))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
}
