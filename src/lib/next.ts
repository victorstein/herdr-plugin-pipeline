/** The parts of `bv --robot-triage-by-track` hpipe reads (bv `pkg/analysis/triage.go`). */
export interface MetricState {
  state: string
  reason?: string
}

export interface TriageRecommendation {
  id: string
  title: string
  score: number
  labels?: string[] | null
  reasons?: string[] | null
  unblocks_ids?: string[] | null
  claimable?: boolean
}

/** bv's top pick carries `unblocks` as a count; the IDs come from the matching recommendation. */
export interface TriagePick {
  id: string
  title: string
  score: number
  reasons?: string[] | null
  unblocks?: number
}

export interface TriageTrack {
  track_id: string
  /** bv always prints it, empty when a track has no stated reason. */
  reason?: string
  top_pick?: TriagePick | null
  recommendations?: TriageRecommendation[] | null
}

export interface TriageBlocker {
  id: string
  title: string
  unblocks_ids?: string[] | null
}

export interface TriageAlert {
  type: string
  severity: string
  message: string
}

export interface TriageByTrack {
  /** Keyed by bv's Go field names (`PageRank`, `Cycles`, …): the struct carries no JSON tags. */
  status?: Record<string, MetricState>
  recommendations_by_track?: TriageTrack[] | null
  blockers_to_clear?: TriageBlocker[] | null
  alerts?: TriageAlert[] | null
}

export interface NextOptions {
  limit: number
  label: string | null
}

const unblocking = (ids: string[] | null | undefined): string =>
  ids === null || ids === undefined || ids.length === 0 ? '' : ` — unblocks ${ids.join(', ')}`

function metricWarnings(status: Record<string, MetricState> | undefined): string[] {
  return Object.entries(status ?? {})
    .filter(([, metric]) => metric.state !== 'computed')
    .map(([name, metric]) => {
      const key = name.toLowerCase()
      const consequence = key === 'cycles'
        ? ' — cycle-free not proven'
        : metric.reason === undefined ? '' : ` — ${metric.reason}`
      return `warning: ${key}: ${metric.state}${consequence}`
    })
}

/**
 * Tracks share no dependency, but bv knows nothing about files: two picks from
 * different tracks still serialise with `--files` when they touch the same ones.
 */
export function formatNext(triage: TriageByTrack, held: ReadonlySet<string>, options: NextOptions): string {
  const lines = metricWarnings(triage.status)
  const wanted = (rec: TriageRecommendation): boolean =>
    !held.has(rec.id) && (options.label === null || (rec.labels ?? []).includes(options.label))
  const tracks = (triage.recommendations_by_track ?? [])
    .map((track) => ({ track, recommendations: (track.recommendations ?? []).filter(wanted) }))
    .filter(({ recommendations }) => recommendations.length > 0)
    .slice(0, options.limit)

  if (tracks.length === 0) lines.push('nothing to pick up: every open bead is held, blocked or filtered out')
  for (const { track, recommendations } of tracks) {
    lines.push(`track ${track.track_id}${track.reason ? ` — ${track.reason}` : ''}`)
    const top = recommendations.find((rec) => rec.id === track.top_pick?.id)
      ?? recommendations.find((rec) => rec.claimable === true)
    if (top === undefined) {
      lines.push('  no claimable pick')
    } else {
      lines.push(`  top: ${top.id} "${top.title}" score ${top.score.toFixed(2)}${unblocking(top.unblocks_ids)}`)
      const reasons = top.reasons ?? []
      if (reasons.length > 0) lines.push(`    why: ${reasons.join('; ')}`)
    }
    const others = recommendations.filter((rec) => rec !== top).map((rec) => rec.id)
    if (others.length > 0) lines.push(`  also: ${others.join(', ')}`)
  }

  const blockers = triage.blockers_to_clear ?? []
  if (blockers.length > 0) {
    lines.push('blockers to clear:', ...blockers.map((b) => `  ${b.id} "${b.title}"${unblocking(b.unblocks_ids)}`))
  }
  const alerts = triage.alerts ?? []
  if (alerts.length > 0) {
    lines.push('alerts:', ...alerts.map((a) => `  [${a.severity}] ${a.type}: ${a.message}`))
  }
  return lines.join('\n')
}
