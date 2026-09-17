import { type PhaseRow, runRow, taskRow } from '../lib/phases'
import { absoluteArtifactPath } from './deliver'
import type { AgentStatus, Run, StallState, Task } from '../lib/types'

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

const MS_PER_MINUTE = 60_000

/** Signals the probed actor produces by its own work. Only these escalate. */
const ESCALATING_SIGNALS: ReadonlySet<string> = new Set(['artifact', 'verdict', 'pr'])

export type StallAction = 'probe' | 'escalate'

export interface StallCandidate {
  run: Run
  task: Task | null
  action: StallAction
  /** Probes SENT so far — never deferrals. Drives the ladder sentence and the reason string. */
  probes: number
  escalatable: boolean
  /** Age in the current phase, for the prompt. */
  minutes: number
  /** Where the probe is SENT. Falls back to the orchestrator for a paneless worker. */
  paneId: string
  /** Whose status gates a deferral. NOT the fallback. */
  actorPaneId: string | null
  /** Transitional: `sendProbes` keys on this until step 10. Removed in step 12. */
  key: string
}

/**
 * The pane of the actor that OWNS the row, with no orchestrator fallback. A
 * paneless worker yields `null`, meaning "the owner is gone, escalate without
 * consulting anyone" — consulting `probePaneFor`'s fallback would gate a
 * worker's escalation on an unrelated agent's status.
 */
function actorPaneFor(run: Run, row: PhaseRow<string>, task: Task | null): string | null {
  return row.actor === 'worker' ? (task?.pane_id ?? null) : run.orchestrator_pane
}

function candidateFor(
  run: Run, record: Run | Task, row: PhaseRow<string>, task: Task | null,
  now: number, thresholdMinutes: number, probeMax: number,
): StallCandidate | null {
  const paneId = probePaneFor(run, row, task?.pane_id ?? null)
  if (!paneId) return null

  const state = stallStateFor(run, record)
  // The anchor is the last rung climbed, NOT the phase entry: anchoring on age
  // makes every rung due at once for a record first seen past its threshold.
  if (now - state.last_probe_at < thresholdMinutes * MS_PER_MINUTE) return null

  const escalatable = ESCALATING_SIGNALS.has(row.signal)
  return {
    run,
    task,
    action: escalatable && state.probes >= probeMax ? 'escalate' : 'probe',
    probes: state.probes,
    escalatable,
    minutes: Math.floor((now - record.phase_entered_at) / MS_PER_MINUTE),
    paneId,
    actorPaneId: actorPaneFor(run, row, task),
    key: `${run.run_id}:${task?.task_id ?? ''}:${record.phase_entered_at}`,
  }
}

export function stallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, probeMax: number,
): StallCandidate[] {
  const out: StallCandidate[] = []
  for (const run of runs) {
    const row = runRow(run.phase)
    if (!row.stallable) continue
    if (row.stallWhen && !row.stallWhen(run)) continue
    const c = candidateFor(run, run, row, null, now, thresholdMinutes, probeMax)
    if (c) out.push(c)
  }
  return out
}

export function taskStallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, probeMax: number,
): StallCandidate[] {
  const out: StallCandidate[] = []
  for (const run of runs) {
    // A run in a pane-releasing phase is not being driven — `pickOneAdvance`
    // skips it for the same reason (`src/supervisor/tick.ts:109`), and
    // `cmdAbort` parks a run in `done` with its tasks intact.
    if (runRow(run.phase).releasesPane === true) continue
    for (const task of run.tasks) {
      const row = taskRow(task.phase)
      if (!row.stallable) continue
      const c = candidateFor(run, task, row, task, now, thresholdMinutes, probeMax)
      if (c) out.push(c)
    }
  }
  return out
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

/**
 * The ladder sentence, composed here rather than templated, because a bare
 * "probe N of M" is false for every row escalation excludes: those keep being
 * probed past the cap and are never escalated.
 */
export function ladderFor(c: { probes: number; escalatable: boolean }, probeMax: number): string {
  if (!c.escalatable) {
    return 'This is a standing nudge — this phase is not escalated automatically, and clears ' +
      'when whatever it is waiting for arrives.'
  }
  return `This is probe ${c.probes + 1} of ${probeMax}. After ${probeMax} unanswered probes ` +
    'this phase is escalated to the human and stops moving on its own.'
}

export interface StallDeps {
  probeMax: number
  now: () => number
  probe: (c: StallCandidate) => Promise<{ ok: boolean }>
  /** Performs the ledger transition AND persists it, then sends. Never gated. */
  escalate: (c: StallCandidate) => Promise<void>
  agentStatus: (paneId: string) => Promise<AgentStatus>
  persist: (run: Run) => Promise<void>
}

/**
 * A bump is persisted immediately: `listRuns` re-reads every run from disk each
 * tick (`src/lib/ledger.ts:48-62`) and both `saveRun` sites in the tick
 * (`src/supervisor/main.ts:136`, `:217`) precede this block, so an unpersisted
 * bump is discarded and `last_probe_at` never advances — the rung-per-tick
 * burst again.
 */
export async function applyStalls(
  candidates: StallCandidate[], deps: StallDeps,
): Promise<void> {
  for (const c of candidates) {
    const record: Run | Task = c.task ?? c.run

    if (c.action === 'probe') {
      if ((await deps.probe(c)).ok) {
        bumpStall(c.run, record, 'probes', deps.now())
        await deps.persist(c.run)
      }
      continue
    }

    const { holds } = stallStateFor(c.run, record)
    if (
      holds < deps.probeMax && c.actorPaneId !== null &&
      (await deps.agentStatus(c.actorPaneId)) === 'working'
    ) {
      bumpStall(c.run, record, 'holds', deps.now())
      await deps.persist(c.run)
      continue
    }

    await deps.escalate(c)
  }
}
