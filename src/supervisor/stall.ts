import { ARTIFACT_RUN_PHASES } from '../lib/machine'
import type { Run } from '../lib/types'

export interface StallCandidate { run: Run; key: string; minutes: number }

export function stallKey(run: Run): string {
  return `${run.run_id}:${run.phase}:${run.phase_entered_at}`
}

export function stallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, alreadyProbed: Set<string>,
): StallCandidate[] {
  const out: StallCandidate[] = []

  for (const run of runs) {
    if (!ARTIFACT_RUN_PHASES.has(run.phase)) continue
    if (!run.orchestrator_pane) continue

    const minutes = (now - run.phase_entered_at) / 60_000
    if (minutes < thresholdMinutes) continue

    const key = stallKey(run)
    if (alreadyProbed.has(key)) continue

    out.push({ run, key, minutes: Math.floor(minutes) })
  }

  return out
}
