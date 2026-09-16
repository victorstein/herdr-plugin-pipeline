import { runRow } from '../lib/phases'
import type { Run, Task } from '../lib/types'

export interface StallCandidate { run: Run; key: string; minutes: number }

export function stallKey(run: Run): string {
  return `${run.run_id}:${run.phase}:${run.phase_entered_at}`
}

export function stallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, alreadyProbed: Set<string>,
): StallCandidate[] {
  const out: StallCandidate[] = []

  for (const run of runs) {
    const signal = runRow(run.phase).signal
    if (signal !== 'artifact' && signal !== 'verdict') continue
    if (!run.orchestrator_pane) continue

    const minutes = (now - run.phase_entered_at) / 60_000
    if (minutes < thresholdMinutes) continue

    const key = stallKey(run)
    if (alreadyProbed.has(key)) continue

    out.push({ run, key, minutes: Math.floor(minutes) })
  }

  return out
}

export interface TaskStallCandidate { run: Run; task: Task; key: string; minutes: number }

export function taskStallKey(run: Run, task: Task): string {
  return `${run.run_id}:${task.task_id}:${task.phase}:${task.phase_entered_at}`
}

/**
 * `implement` is the only task phase worth probing: every other phase is either
 * orchestrator-owned (and covered by the run-level probe's actor gate) or
 * driven by an external service. A worker whose pane hangs without emitting
 * `pane.exited` would otherwise go unnoticed indefinitely.
 */
export function taskStallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, alreadyProbed: Set<string>,
): TaskStallCandidate[] {
  const out: TaskStallCandidate[] = []

  for (const run of runs) {
    if (!run.orchestrator_pane) continue
    for (const task of run.tasks) {
      if (task.phase !== 'implement') continue

      const minutes = (now - task.phase_entered_at) / 60_000
      if (minutes < thresholdMinutes) continue

      const key = taskStallKey(run, task)
      if (alreadyProbed.has(key)) continue

      out.push({ run, task, key, minutes: Math.floor(minutes) })
    }
  }

  return out
}
