/** The parts of `bv --robot-triage-by-track` hpipe reads (bv `pkg/analysis/triage.go`). */
export interface MetricState {
  state: string
  reason?: string
}

/** Go nil slices print as `null`, so every list bv emits may be null. */
export interface TriageRecommendation {
  id: string
  title: string
  score: number
  labels?: string[] | null
  reasons?: string[] | null
  unblocks_ids?: string[] | null
  claimable?: boolean
}

/**
 * One topological layer (`buildRecommendationsByTrack`): `track-A` is everything
 * actionable now, each later track waits on the one before it, and cyclic beads
 * share a last track whose reason says so.
 */
export interface TriageTrack {
  track_id: string
  reason?: string
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

/** bv's whole robot envelope: `source_authority` sits beside `triage`, not inside it. */
export interface TriageOutput {
  triage: TriageByTrack
  source_authority?: { claim_safe?: boolean } | null
}

export interface NextOptions {
  limit: number
  label: string | null
}

const ACTIONABLE_TRACK = 'track-A'
const CYCLIC_REASON_PREFIX = 'Cyclic'
// Triage always runs with bv's TriageConfig, which skips most metrics and samples
// betweenness, so `skipped` and `approx` are routine; only these mean a metric failed.
const FAILED_METRIC_STATES = new Set(['timeout', 'pending', 'error'])
const IDS_PER_LINE = 8
const MAX_ALERTS = 5

const unblocking = (ids: string[] | null | undefined): string =>
  ids === null || ids === undefined || ids.length === 0 ? '' : ` → frees ${ids.join(', ')}`

const LEADING_PICTOGRAPH = /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0F\u200D]*\s*/u
// Dots stay inside a word for bd's hierarchical ids (`hp-1.2`); a sentence's full stop is trimmed.
const BEAD_ID_DELIMITER = /[^\p{L}\p{N}_.-]+/u

/** bv decorates its reasons (🔓 📊 ✅ ⏳); the orchestrator reads plain text. */
const plainReason = (reason: string): string => reason.replace(LEADING_PICTOGRAPH, '')

const namesEvery = (reason: string, ids: readonly string[]): boolean => {
  const words = new Set(reason.split(BEAD_ID_DELIMITER).map((word) => word.replace(/\.+$/, '')))
  return ids.every((id) => words.has(id))
}

const idList = (ids: string[]): string =>
  ids.length <= IDS_PER_LINE
    ? ids.join(', ')
    : `${ids.slice(0, IDS_PER_LINE).join(', ')} +${ids.length - IDS_PER_LINE} more`

function metricWarnings(status: Record<string, MetricState> | undefined): string[] {
  return Object.entries(status ?? {})
    .filter(([, metric]) => FAILED_METRIC_STATES.has(metric.state))
    .map(([name, metric]) =>
      `warning: ${name.toLowerCase()}: ${metric.state}${metric.reason ? ` — ${metric.reason}` : ''}`)
}

function pickLine(rec: TriageRecommendation): string {
  const why = rec.reasons?.[0] === undefined ? '' : plainReason(rec.reasons[0])
  const frees = why !== '' && namesEvery(why, rec.unblocks_ids ?? []) ? '' : unblocking(rec.unblocks_ids)
  return `  ${rec.id} "${rec.title}" score ${rec.score.toFixed(2)}${why ? ` — ${why}` : ''}${frees}`
}

/**
 * Picks in the actionable layer can run in parallel, but bv knows nothing about
 * files: two of them still serialise through `--files` when they touch the same ones.
 */
export function formatNext(output: TriageOutput, held: ReadonlySet<string>, options: NextOptions): string {
  const { triage } = output
  const lines = metricWarnings(triage.status)
  if (output.source_authority?.claim_safe === false) {
    lines.push('warning: bv blanked every pick: the export has records it could not load, so nothing is proven claimable')
  }
  const wanted = (rec: TriageRecommendation): boolean =>
    !held.has(rec.id) && (options.label === null || (rec.labels ?? []).includes(options.label))
  const layers = (triage.recommendations_by_track ?? [])
    .map((track) => ({ track, recommendations: (track.recommendations ?? []).filter(wanted) }))

  const actionable = layers.find(({ track }) => track.track_id === ACTIONABLE_TRACK)?.recommendations ?? []
  const picks = actionable.filter((rec) => rec.claimable === true)
    .sort((a, b) => b.score - a.score).slice(0, options.limit)
  const notClaimable = actionable.filter((rec) => rec.claimable !== true).map((rec) => rec.id)

  const later: string[] = []
  let previous = ACTIONABLE_TRACK
  for (const { track, recommendations } of layers) {
    if (track.track_id === ACTIONABLE_TRACK) continue
    const ids = recommendations.map((rec) => rec.id)
    if (track.reason?.startsWith(CYCLIC_REASON_PREFIX)) {
      if (ids.length > 0) later.push(`cyclic, until the cycle is broken: ${idList(ids)}`)
      continue
    }
    if (ids.length > 0) later.push(`after ${previous}: ${track.track_id} ${idList(ids)}`)
    previous = track.track_id
  }

  if (picks.length === 0 && notClaimable.length === 0 && later.length === 0) {
    lines.push('nothing to pick up: every open bead is held, blocked or filtered out')
  } else {
    if (picks.length === 0) lines.push('now: nothing claimable')
    else lines.push('now (parallel when their --files are disjoint):', ...picks.map(pickLine))
    if (notClaimable.length > 0) lines.push(`  not claimable: ${idList(notClaimable)}`)
    lines.push(...later)
  }

  const blockers = triage.blockers_to_clear ?? []
  if (blockers.length > 0) {
    lines.push('blockers to clear:', ...blockers.map((b) => `  ${b.id} "${b.title}"${unblocking(b.unblocks_ids)}`))
  }
  const alerts = triage.alerts ?? []
  if (alerts.length > 0) {
    lines.push('alerts:', ...alerts.slice(0, MAX_ALERTS).map((a) => `  [${a.severity}] ${a.type}: ${a.message}`))
    if (alerts.length > MAX_ALERTS) lines.push(`  +${alerts.length - MAX_ALERTS} more`)
  }
  return lines.join('\n')
}
