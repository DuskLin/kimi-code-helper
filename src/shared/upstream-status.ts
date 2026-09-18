/** HTTP 200 can still describe an interrupted generation. */
export function generationFailure(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return
  for (const choice of choices) {
    const reason = choice?.finish_reason
    if (reason === 'aborted' || reason === 'insufficient_system_resource') return reason
  }
  return
}
