import type { RegistryModelCapabilities } from '../../shared/contracts'

type Node = Record<string, unknown>
const record = (value: unknown): Node =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Node) : {}
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 100)
    ? [...new Set(value.map((item) => item.trim()))]
    : undefined

/** Normalize both Models.dev metadata and the persisted registry fields. */
export function parseRegistryCapabilities(value: unknown): RegistryModelCapabilities | undefined {
  const node = record(value)
  const result: RegistryModelCapabilities = {}
  for (const key of ['reasoning', 'tool_call'] as const) {
    if (typeof node[key] === 'boolean') result[key] = node[key]
  }
  const modalities = record(node.modalities)
  for (const key of ['input', 'output'] as const) {
    const values = strings(modalities[key])
    if (values) (result.modalities ??= {})[key] = values
  }
  let efforts = strings(node.support_efforts)
  if (!efforts && Array.isArray(node.reasoning_options)) {
    const declared = node.reasoning_options
      .map(record)
      .filter((option) => option.type === 'effort')
      .map((option) => strings(option.values))
      .filter((values) => values !== undefined)
    if (declared.length) efforts = [...new Set(declared.flat())]
  }
  if (efforts && result.reasoning !== false) {
    result.support_efforts = efforts
    if (typeof node.default_effort === 'string' && efforts.includes(node.default_effort))
      result.default_effort = node.default_effort
  }
  return Object.keys(result).length ? result : undefined
}

/** Only advertise capabilities shared by every account that can serve this model. */
export function mergeRegistryCapabilities(
  sources: (RegistryModelCapabilities | undefined)[]
): RegistryModelCapabilities {
  const result: RegistryModelCapabilities = {}
  if (!sources.length) return result
  for (const key of ['reasoning', 'tool_call'] as const) {
    if (sources.some((source) => source?.[key] === false)) result[key] = false
    else if (sources.every((source) => source?.[key] === true)) result[key] = true
  }
  const common = (values: (string[] | undefined)[]): string[] | undefined =>
    values.every((value) => value !== undefined)
      ? values[0]!.filter((value) => values.every((list) => list!.includes(value)))
      : undefined
  for (const key of ['input', 'output'] as const) {
    const values = common(sources.map((source) => source?.modalities?.[key]))
    if (values) (result.modalities ??= {})[key] = values
  }
  const efforts = common(sources.map((source) => source?.support_efforts))
  if (efforts && result.reasoning !== false) {
    result.support_efforts = efforts
    const fallback = sources[0]?.default_effort
    if (
      fallback &&
      efforts.includes(fallback) &&
      sources.every((source) => source?.default_effort === fallback)
    )
      result.default_effort = fallback
  }
  return result
}
