import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parse, stringify } from 'yaml'

const [source, destination] = process.argv.slice(2)
if (!source || !destination) throw new Error('Usage: node scripts/prepare-release.mjs INPUT OUTPUT')
await mkdir(destination, { recursive: true })
const manifests = new Map()
const assets = new Map()
for (const directory of (await readdir(source)).sort()) {
  const files = await readdir(join(source, directory))
  if (!files.some((file) => file.endsWith('.yml')))
    throw new Error(`Missing update manifest: ${directory}`)
  for (const name of files.sort()) {
    const path = join(source, directory, name)
    if (name.endsWith('.yml')) {
      const manifest = parse(await readFile(path, 'utf8'))
      if (!manifest.version || !Array.isArray(manifest.files) || !manifest.files.length)
        throw new Error(`Invalid update manifest: ${name}`)
      const existing = manifests.get(name)
      if (existing && existing.version !== manifest.version)
        throw new Error(`Mismatched release versions: ${name}`)
      manifests.set(
        name,
        existing ? { ...existing, files: [...existing.files, ...manifest.files] } : manifest
      )
    } else {
      if (assets.has(name)) throw new Error(`Duplicate release asset: ${name}`)
      assets.set(name, path)
      await copyFile(path, join(destination, name))
    }
  }
}
for (const [name, manifest] of manifests) {
  const urls = new Set()
  for (const file of manifest.files) {
    if (typeof file.url !== 'string' || basename(file.url) !== file.url || urls.has(file.url))
      throw new Error(`Invalid or duplicate asset URL: ${name}`)
    urls.add(file.url)
    const path = assets.get(file.url)
    if (!path) throw new Error(`Missing release asset: ${file.url}`)
    const data = await readFile(path)
    if (
      createHash('sha512').update(data).digest('base64') !== file.sha512 ||
      data.length !== file.size
    )
      throw new Error(`Invalid release checksum or size: ${file.url}`)
  }
  // The files array contains both Mac architectures; do not overwrite one latest-mac.yml with the other.
  manifest.path = manifest.files[0].url
  manifest.sha512 = manifest.files[0].sha512
  await writeFile(join(destination, name), stringify(manifest))
}
