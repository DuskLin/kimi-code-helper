import { fileURLToPath, pathToFileURL } from 'node:url'

export function isTrustedRendererUrl(
  value: string,
  rendererFile: string,
  developmentUrl?: string,
  windows = process.platform === 'win32'
): boolean {
  try {
    const url = new URL(value)
    if (developmentUrl) return url.origin === new URL(developmentUrl).origin
    if (url.protocol !== 'file:' || url.search) return false
    // Electron and Node encode characters such as ~ differently. Compare file
    // URLs after the same round trip, while still trusting only the renderer file.
    return (
      pathToFileURL(fileURLToPath(url, { windows }), { windows }).href ===
      pathToFileURL(rendererFile, { windows }).href
    )
  } catch {
    return false
  }
}
