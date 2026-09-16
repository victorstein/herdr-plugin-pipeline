import { type PhaseRow, runRow, taskRow } from '../lib/phases'
import type { Run, Task } from '../lib/types'

export interface StallCandidate {
  run: Run
  key: string
  minutes: number
  paneId: string
  taskId: string | null
}

export function stallKey(run: Run): string {
  return `${run.run_id}:${run.phase}:${run.phase_entered_at}`
}

/**
 * A row whose actor has no pane of its own is stranded until someone outside it
 * acts, so the table points it at the orchestrator. A worker row can also end up
 * paneless — a dispatch prompt that never landed leaves no pane to nudge — and
 * the same fallback keeps the probe reaching someone.
 */
function probePaneFor(run: Run, row: PhaseRow<string>, taskPane: string | null): string | null {
  if (row.probeTarget === 'orchestrator') return run.orchestrator_pane
  if (row.actor === 'worker') return taskPane ?? run.orchestrator_pane
  return run.orchestrator_pane
}

export function stallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, alreadyProbed: Set<string>,
): StallCandidate[] {
  const out: StallCandidate[] = []

  for (const run of runs) {
    const row = runRow(run.phase)
    if (!row.stallable) continue
    if (row.stallWhen && !row.stallWhen(run)) continue

    const paneId = probePaneFor(run, row, null)
    if (!paneId) continue

    const minutes = (now - run.phase_entered_at) / 60_000
    if (minutes < thresholdMinutes) continue

    const key = stallKey(run)
    if (alreadyProbed.has(key)) continue

    out.push({ run, key, minutes: Math.floor(minutes), paneId, taskId: null })
  }

  return out
}

export interface TaskStallCandidate {
  run: Run
  task: Task
  key: string
  minutes: number
  paneId: string
  taskId: string
}

export function taskStallKey(run: Run, task: Task): string {
  return `${run.run_id}:${task.task_id}:${task.phase}:${task.phase_entered_at}`
}

export function taskStallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, alreadyProbed: Set<string>,
): TaskStallCandidate[] {
  const out: TaskStallCandidate[] = []

  for (const run of runs) {
    for (const task of run.tasks) {
      const row = taskRow(task.phase)
      if (!row.stallable) continue

      const paneId = probePaneFor(run, row, task.pane_id)
      if (!paneId) continue

      const minutes = (now - task.phase_entered_at) / 60_000
      if (minutes < thresholdMinutes) continue

      const key = taskStallKey(run, task)
      if (alreadyProbed.has(key)) continue

      out.push({ run, task, key, minutes: Math.floor(minutes), paneId, taskId: task.task_id })
    }
  }

  return out
}

/**
 * The key carries `phase_entered_at`, so a candidate marked probed is never
 * retried for that phase entry — marking one the send failed on would drop the
 * probe silently and for good.
 */
export async function sendProbes<C extends { key: string }>(
  candidates: C[], probed: Set<string>, send: (candidate: C) => Promise<{ ok: boolean }>,
): Promise<void> {
  for (const candidate of candidates) {
    if ((await send(candidate)).ok) probed.add(candidate.key)
  }
}
