// Arguments are passed to /bin/sh separately; never interpolate paths into shell source.
export const macInstallScript = `#!/bin/sh
set -eu
parent_pid="$1"
target="$2"
staged="$3"
backup="$4"
launcher="$5"
attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo 'App did not exit; installation cancelled, original app preserved.'
    exit 1
  fi
  sleep 1
done
if [ ! -d "$target" ] || [ ! -d "$staged" ] || [ -e "$backup" ]; then
  echo 'Invalid installation paths; original app preserved.'
  exit 1
fi
mv "$target" "$backup"
if ! mv "$staged" "$target"; then
  mv "$backup" "$target"
  "$launcher" -n "$target" || true
  echo 'Replacement failed; original app restored.'
  exit 1
fi
if ! "$launcher" -n "$target"; then
  mv "$target" "$staged"
  mv "$backup" "$target"
  "$launcher" -n "$target" || true
  echo 'Launch failed; original app restored.'
  exit 1
fi
echo "Update installed. Previous application retained at: $backup"
`

export function validateMacArchive(entries: string[]): void {
  if (
    !entries.length ||
    entries.some(
      (entry) =>
        !entry.startsWith('Navo.app/') || entry.split('/').includes('..') || entry.includes('\\')
    )
  )
    throw new Error('更新压缩包包含无效路径')
}

export function validateMacExecutable(header: Buffer, arch: string): void {
  const expectedCpu = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : -1
  if (
    header.length >= 8 &&
    header.readUInt32LE(0) === 0xfeedfacf &&
    header.readUInt32LE(4) === expectedCpu
  )
    return
  if (header.length >= 8 && [0xcafebabe, 0xcafebabf].includes(header.readUInt32BE(0))) {
    const count = header.readUInt32BE(4)
    const stride = header.readUInt32BE(0) === 0xcafebabf ? 32 : 20
    if (count <= 64 && header.length >= 8 + count * stride) {
      for (let index = 0; index < count; index++)
        if (header.readUInt32BE(8 + index * stride) === expectedCpu) return
    }
  }
  throw new Error('更新应用的处理器架构不匹配')
}
