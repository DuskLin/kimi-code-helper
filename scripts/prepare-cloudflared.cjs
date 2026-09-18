const { readFile, writeFile, mkdir, chmod, copyFile, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const manifest = require('./cloudflared-manifest.json')

async function prepare(context) {
  const platform = context?.electronPlatformName || process.platform
  const arch = context
    ? ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch]
    : process.arch
  const key = `${platform}-${arch}`
  const asset = manifest.assets[key]
  if (!asset) throw new Error(`Unsupported bundled cloudflared target: ${key}`)
  const directory = join(__dirname, '../build/cloudflared', key)
  await mkdir(directory, { recursive: true })
  const archive = join(directory, asset.name)
  let bytes = await readFile(archive).catch(() => null)
  const digest = (value) => createHash('sha256').update(value).digest('hex')
  if (!bytes || digest(bytes) !== asset.sha256) {
    const response = await fetch(
      `https://github.com/cloudflare/cloudflared/releases/download/${manifest.version}/${asset.name}`,
      { signal: AbortSignal.timeout(120000) }
    )
    if (!response.ok) throw new Error(`cloudflared download failed: ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (digest(bytes) !== asset.sha256)
      throw new Error('cloudflared SHA-256 mismatch; refusing to bundle')
    await writeFile(archive, bytes)
  }
  const binaryName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const target = join(directory, binaryName)
  if (asset.name.endsWith('.tgz'))
    execFileSync('tar', ['-xzf', archive, '-C', directory, 'cloudflared'])
  else await copyFile(archive, target)
  await chmod(target, 0o755)
  // electron-builder's ${os} names differ from Node's process.platform.
  const bundle = join(
    __dirname,
    '../build/cloudflared-bundle',
    `${{ darwin: 'mac', win32: 'win', linux: 'linux' }[platform]}-${arch}`
  )
  await mkdir(bundle, { recursive: true })
  await copyFile(target, join(bundle, binaryName))
  await chmod(join(bundle, binaryName), 0o755)
  await copyFile(join(__dirname, '../docs/cloudflared-LICENSE'), join(bundle, 'LICENSE'))
  console.log(`Bundled cloudflared ${manifest.version} (${key}), verified SHA-256`)
}
module.exports = prepare
if (require.main === module)
  prepare().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
