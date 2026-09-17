import { type PhaseRow, runRow, taskRow } from '../lib/phases'
import { absoluteArtifactPath } from './deliver'
import type { Run, StallState, Task } from '../lib/types'

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

/**
 * The ladder state for this phase entry, or a fresh one. BOTH stamps must
 * match: `at` re-arms on the record's own phase entry, `run_at` on the run's —
 * which is what makes `hpipe resume` re-arm a task's ladder even though
 * `cmdResume` (`src/cli.ts:304-320`) never walks `run.tasks`.
 */
export function stallStateFor(run: Run, record: Run | Task): StallState {
  const s = record.stall
  if (s && s.at === record.phase_entered_at && s.run_at === run.phase_entered_at) return s
  return {
    at: record.phase_entered_at,
    run_at: run.phase_entered_at,
    last_probe_at: Math.max(record.phase_entered_at, run.phase_entered_at),
    probes: 0,
    holds: 0,
  }
}

/**
 * Advances the ladder by one rung and moves the due anchor. Rewriting `at` and
 * `run_at` is REQUIRED, not incidental: `stallStateFor` rejects a mismatched
 * stamp, so a bump that advanced only `last_probe_at` and the counter would be
 * rejected on the next read, re-anchor every tick, and never accumulate — which
 * is the rung-per-tick burst this design exists to prevent.
 */
export function bumpStall(
  run: Run, record: Run | Task, kind: 'probes' | 'holds', now: number,
): void {
  const s = stallStateFor(run, record)
  record.stall = {
    at: record.phase_entered_at,
    run_at: run.phase_entered_at,
    last_probe_at: now,
    probes: s.probes + (kind === 'probes' ? 1 : 0),
    holds: s.holds + (kind === 'holds' ? 1 : 0),
  }
}

export interface Awaiting {
  /** The whole waiting paragraph, so the template asserts nothing about its shape. */
  clause: string
  /** A noun phrase, for the escalation prompt's single sentence. */
  short: string
}

/**
 * What this phase is waiting for, phrased so the sentence is true of what it
 * names. Keyed on `row.signal` rather than the phase name, so #19 making more
 * rows stallable needs no change here. `hpipe` arrives already rendered:
 * `render` never re-scans replacement text (`src/lib/render.ts:8-14`), so a
 * `{{hpipe}}` inside a VALUE would ship to an agent verbatim.
 */
export function stallAwaiting(run: Run, task: Task | null, hpipe: string): Awaiting {
  const row = task ? taskRow(task.phase) : runRow(run.phase)
  const phase = task ? task.phase : run.phase
  const sentence = (short: string): Awaiting =>
    ({ short, clause: `This phase is waiting for ${short}.` })

  if (row.signal === 'artifact' || row.signal === 'verdict') {
    const path = absoluteArtifactPath(run, task)
    if (path !== null) {
      return {
        short: row.signal === 'artifact' ? 'its research/spec/plan artifact' : 'its review verdict',
        clause: `Nothing has appeared at:\n\n    ${path}\n\n` +
          'If you finished but wrote it elsewhere, move it exactly there — ' +
          'the supervisor stats that path and nothing else.',
      }
    }
  }
  if (row.signal === 'pr' && task) {
    return sentence(`a pushed PR for ${task.branch} (#${task.issue})`)
  }
  if (row.signal === 'files') {
    return {
      short: 'the files another task holds',
      clause: 'This phase is waiting for another task to release the files this one declared.',
    }
  }
  if (row.signal === 'manual') return sentence('an answer to the open decision')
  if (row.signal === 'worktree') {
    return task
      ? { short: 'its worktree to be removed',
          clause: "This phase is waiting for this task's worktree to be removed." }
      : { short: 'a worktree for a dispatched task',
          clause: 'This phase is waiting for a worktree to be adopted for a dispatched task.' }
  }
  if (row.signal === 'gate') {
    return {
      short: 'intake to be closed',
      clause: `This phase is waiting for \`${hpipe} dispatch --done\` to close intake.`,
    }
  }
  return sentence(`whatever clears ${phase}`)
}
