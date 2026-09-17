import { networkInterfaces } from 'node:os'

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  )
}

export function lanAddresses(interfaces = networkInterfaces()): string[] {
  return [
    ...new Set(
      Object.values(interfaces).flatMap((entries) =>
        (entries ?? [])
          .filter(
            (entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)
          )
          .map((entry) => entry.address)
      )
    )
  ].sort(
    (a, b) =>
      Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')) || a.localeCompare(b)
  )
}
