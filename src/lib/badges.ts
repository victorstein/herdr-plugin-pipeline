const MAX_VALUE = 80

export function badgeSource(pluginId: string): string {
  return `plugin:${pluginId}`
}

export function buildBadges(input: {
  agent_status: string
  branch: string
  phase: string
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    status: input.agent_status,
    branch: input.branch,
    phase: input.phase,
  })) {
    if (value.length === 0) continue
    out[key] = value.slice(0, MAX_VALUE)
  }
  return out
}
