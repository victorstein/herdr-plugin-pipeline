import { awaitedFor } from './awaiting'
import { openDecisionFor } from './decisions'
import { filesOverlap, isInFlight } from './gating'
import { counterFor } from './machine'
import { runIsDriven, wasAborted } from './ledger'
import type { PaneHold } from './delivery-health'
import { deliveryWarnings, type PaneObservations, queuedWorkerPrompt } from './outbox'
import { runRow, taskRow } from './phases'
import type { MissingArtifact, Run, SessionKey, Task, UncommittedWork } from './types'
import {
  briefCommand, dispatchWorkerCommand, overdueUndispatchedWorker, overdueUnstartedWorker,
  remainingDispatchSteps, startWorkerCommand, unbriefedWorker,
} from './unstarted'

export interface StatusSupervisor {
  state: 'live' | 'stale' | 'none' | 'other-session'
  pid?: number
}

const MS_PER_MINUTE = 60_000
const DISPATCH_UNDER_WAY = 'dispatch under way'

/** Clamped: a future stamp from clock skew must not print "-1m" at an operator. */
export function ageMinutes(sinceMs: number, now: number): number {
  return Math.max(0, Math.floor((now - sinceMs) / MS_PER_MINUTE))
}

/**
 * A holder that will never tear itself down. `hpipe release` refuses an
 * in-flight holder, so offering it against a healthy one sends the human at a
 * command that will bounce; only one of these is releasable.
 */
function hasStoppedMoving(task: Task): boolean {
  return taskRow(task.phase).terminal === true || task.phase === 'escalated'
}

function fileHolders(run: Run, task: Task): Task[] {
  return run.tasks.filter(
    (t) => t.task_id !== task.task_id && isInFlight(t) && filesOverlap(task.files, t.files),
  )
}

/**
 * Whether a supervisor-written observation of an idle worker still describes it.
 * Only the supervisor's own evaluation clears such a record, and it never reaches
 * a run parked in a pane-releasing phase (`cmdAbort` leaves tasks intact in
 * `done`) or a worker with no pane — so for those the record is left behind, not
 * live.
 */
function isCurrentObservation(run: Run, task: Task, at: number): boolean {
  if (!runIsDriven(run) || task.pane_id === null) return false
  return at === task.phase_entered_at
}

function currentMissingArtifact(run: Run, task: Task): MissingArtifact | null {
  const missing = task.artifact_missing
  return missing !== undefined && isCurrentObservation(run, task, missing.at) ? missing : null
}

function adoptionOutcome(missing: MissingArtifact): string {
  return missing.candidates.length === 0
    ? 'its branch added no document to adopt'
    : `${missing.candidates.length} candidates, too many to adopt: ${missing.candidates.join(', ')}`
}

function currentUncommittedWork(run: Run, task: Task): UncommittedWork | null {
  const work = task.uncommitted_work
  return work !== undefined && work.count > 0 && isCurrentObservation(run, task, work.at)
    ? work
    : null
}

function describeUncommitted(work: UncommittedWork): string {
  const more = work.count > work.sample.length ? ', …' : ''
  const noun = work.count === 1 ? 'path' : 'paths'
  return `worker idle with ${work.count} uncommitted ${noun} (${work.sample.join(', ')}${more})`
}

interface Move {
  waitsOnYou: boolean
  clause: string
}

export type PaneHolds = Readonly<Record<string, PaneHold>>

/**
 * A worker owed its own phase prompt has not been told what this phase wants, so
 * neither "idle with nothing" nor uncommitted work says anything about it. A send
 * refused before it goes out settles nothing, so the gate's holds are the only
 * record of stuck input there; the entry's own last code is set only when a send
 * stalled and then found a human's text in the box.
 */
function undeliveredPhasePrompt(run: Run, task: Task, holds: PaneHolds): Move | null {
  const entry = queuedWorkerPrompt(run, task)
  if (entry === null) return null
  const pane = task.pane_id ?? 'its pane'
  const hold = task.pane_id === null ? undefined : holds[task.pane_id]
  if (hold?.code === 'stuck_input' || entry.last_code === 'stuck_input') {
    return {
      waitsOnYou: true,
      clause: `YOUR move: its ${task.phase} prompt is held by text in the input box of ${pane} — ` +
        'submit or clear that text; see the ⚠ stuck input line below',
    }
  }
  if (hold !== undefined || entry.attempts > 0) {
    return {
      waitsOnYou: true,
      clause: `YOUR move: its ${task.phase} prompt has not reached ${pane} — see the ⚠ delivery line below`,
    }
  }
  return { waitsOnYou: false, clause: `nothing for you — its ${task.phase} prompt is queued for ${pane}` }
}

/**
 * The one way back from an escalation, for a run or for one of its tasks. Every
 * channel that tells an operator how to resume renders it here, so status, the
 * digest, the stall ladder and a refused CLI command cannot drift apart.
 */
export function resumeCommand(
  hpipe: string, run: Run, task: Task | null = null,
  from: string | null = task ? task.escalated_from : run.escalated_from,
): string {
  return `${hpipe} rewind ${run.run_id} ${from ?? '<phase>'}${task ? ` --task ${task.task_id}` : ''}`
}

/**
 * The other way out of a task escalation. An escalated task holds its run in
 * `execute` until a human either resumes or abandons it, so every text that names
 * the resume names this too — or the agent told to fetch the human has no way to
 * offer the second choice. A run has no equivalent: `failed` is a task phase.
 */
export function abandonCommand(hpipe: string, run: Run, task: Task): string {
  return `${hpipe} rewind ${run.run_id} failed --task ${task.task_id}`
}

/** The rendered `{{abandon}}` of escalate.md and stall-escalate.md; empty for a run. */
export function abandonParagraph(hpipe: string, run: Run, task: Task | null): string {
  if (task === null) return ''
  return '\n\nIf they decide to drop the task instead:\n\n' +
    `    ${abandonCommand(hpipe, run, task)}\n\n` +
    'The run waits in `execute` until one of the two is run, and the dependents of this task ' +
    'stay queued; abandoning it moves them to `blocked-on-failure`.'
}

function moveFor(run: Run, task: Task, hpipe: string, now: number, holds: PaneHolds = {}): Move {
  const row = taskRow(task.phase)
  const yours = (clause: string): Move => ({ waitsOnYou: true, clause })
  const notYours = (clause: string): Move => ({ waitsOnYou: false, clause })

  if (task.phase === 'done') return notYours('nothing for you — this task is finished')
  if (row.terminal === true) return yours('dead end, needs a human')
  if (task.phase === 'escalated') {
    return yours(
      `needs a human: \`${resumeCommand(hpipe, run, task)}\` resumes it, ` +
      `\`${abandonCommand(hpipe, run, task)}\` abandons it` +
      (run.phase === 'execute' ? ' — the run holds in execute until one is run' : ''),
    )
  }
  if (row.actor === 'orchestrator') {
    // A recorded answer is the supervisor's to deliver; the orchestrator has done its part.
    return task.pending_answer === null
      ? yours(`YOUR move: waiting for ${awaitedFor(task)}`)
      : notYours(`nothing for you — waiting for ${awaitedFor(task)}`)
  }
  if (row.actor === 'worker') {
    const unstarted = overdueUnstartedWorker(run, task, now)
    if (unstarted) {
      return yours('YOUR move: no agent detected in its worktree — ' +
        startWorkerCommand(run, task, unstarted.workspaceId, hpipe))
    }
    // Ahead of the unbriefed check: a rewind into research with no pane marks the
    // task awaiting its brief, and "start an agent" skips the worktree it lacks.
    if (overdueUndispatchedWorker(run, task, now)) {
      return yours(`YOUR move: no worktree and no agent — ${dispatchWorkerCommand(run, task, hpipe)}`)
    }
    const unbriefed = unbriefedWorker(run, task)
    if (unbriefed) {
      // No pane reaches here only inside the bootstrap grace — the overdue checks
      // above claim every other case — and a dispatch still being carried out is
      // not yet the orchestrator's lapse. Measured on a live run.
      if (unbriefed.paneId === null) {
        return notYours(`${DISPATCH_UNDER_WAY} — ${remainingDispatchSteps(run, task, hpipe)}`)
      }
      return yours(`YOUR move: its agent in ${unbriefed.paneId} has not been handed the brief — ` +
        briefCommand(task, unbriefed.paneId, hpipe))
    }
    const undelivered = undeliveredPhasePrompt(run, task, holds)
    if (undelivered) return undelivered
    // An idle worker that has stopped short otherwise reads exactly like a busy
    // one, and the orchestrator waits on it until the stall ladder's first rung.
    const missing = currentMissingArtifact(run, task)
    if (missing) {
      return yours(`YOUR move: worker idle with nothing at ${missing.path} (${adoptionOutcome(missing)})`)
    }
    const work = currentUncommittedWork(run, task)
    if (work) return yours(`YOUR move: ${describeUncommitted(work)} — have it commit and push`)
    return notYours(`worker's move: waiting for ${awaitedFor(task)}`)
  }
  if (task.phase === 'blocked-on-files') {
    // This row has no escalation path of its own — `files` is not in stall.ts's
    // ESCALATING_SIGNALS, so the ladder probes it to the cap and then goes quiet
    // forever. A stuck holder is therefore only ever cleared by a human.
    const stuck = fileHolders(run, task).filter(hasStoppedMoving)
    if (stuck.length > 0) {
      return yours(`YOUR move: ${stuck.map((t) => `\`${hpipe} release --task ${t.task_id}\``).join(', ')}`)
    }
  }
  return notYours('nothing for you — the supervisor is driving')
}

/**
 * The digest footer's predicate. It passes no CLI because only the clause needs
 * one, and the footer renders its clause through `actionFor` separately.
 */
export function waitsOnYou(
  run: Run, task: Task, now: number = Date.now(), holds: PaneHolds = {},
): boolean {
  return moveFor(run, task, '', now, holds).waitsOnYou
}

/**
 * Whose move it is, keyed on the phase row rather than the phase name so a row
 * added to TASK_ROWS gets a correct clause with no edit here. Shared by the
 * digest, its parked-task footer and `hpipe status`, so the three cannot hand an
 * operator different recovery commands for the same task.
 */
export function actionFor(
  run: Run, task: Task, hpipe: string, now: number = Date.now(), holds: PaneHolds = {},
): string {
  return moveFor(run, task, hpipe, now, holds).clause
}

/**
 * A move waiting on you is listed under `waiting on you:`; any other clause
 * printed nowhere, so the grace's "dispatch under way" never showed. Measured on
 * a live run. The grace's full recipe is left to `show`: on a line where nothing
 * is owed yet it only buried the task.
 */
function taskLineMove(run: Run, task: Task, hpipe: string, now: number, holds: PaneHolds): string {
  const move = moveFor(run, task, hpipe, now, holds)
  if (move.waitsOnYou) return ''
  if (move.clause.startsWith(DISPATCH_UNDER_WAY)) {
    return ` — ${DISPATCH_UNDER_WAY} — see \`${hpipe} show --task ${task.task_id}\``
  }
  return ` — ${move.clause}`
}

/**
 * Named explicitly rather than left to be spotted in the task list: a task parked
 * in `merge` for five hours rendered as one more ordinary line on the berean-os
 * run of 2026-09-16. Measured on a live run.
 */
function waitingOnYou(run: Run, hpipe: string, now: number, holds: PaneHolds): string[] {
  const byId = [...run.tasks].sort((a, b) => a.task_id.localeCompare(b.task_id))
  const lines = byId.flatMap((task) => {
    const move = moveFor(run, task, hpipe, now, holds)
    if (!move.waitsOnYou) return []
    const age = ageMinutes(task.phase_entered_at, now)
    return [`    ${task.task_id} ${task.branch} (#${task.issue}) [${task.phase} ${age}m] — ${move.clause}`]
  })
  return lines.length === 0 ? [] : ['  waiting on you:', ...lines]
}

/**
 * Detail the "waiting on you" clause has no room for: the question itself, who
 * holds the files, a stalled answer. Only meaningful once a run is on the
 * current schema.
 */
function taskWarnings(run: Run, hpipe: string, now: number): string[] {
  const lines: string[] = []

  for (const task of run.tasks) {
    const open = openDecisionFor(task)
    if (open) {
      lines.push(
        `  ⚠ ${task.task_id} blocked on an open decision (${ageMinutes(open.asked_at, now)}m): ${open.question}`,
      )
    }

    if (task.pending_answer !== null) {
      const decision = task.decisions.find((d) => d.id === task.pending_answer)
      if (decision) {
        lines.push(
          `  ⚠ ${task.task_id} decision ${decision.id} answered but undelivered ` +
          `(${task.delivery_attempts} delivery attempts) — a fresh \`${hpipe} answer\` re-arms delivery`,
        )
      }
    }

    if (task.phase === 'blocked-on-files') {
      for (const holder of fileHolders(run, task)) {
        lines.push(
          `  ⚠ ${task.task_id} blocked on files held by ${holder.task_id} (${holder.phase}) — ` +
          (hasStoppedMoving(holder)
            ? 'it has stopped moving, so only a release clears it'
            : 'waiting for it to finish'),
        )
      }
    }
  }

  return lines
}

function intakeWarning(run: Run, hpipe: string): string[] {
  if (run.phase !== 'execute' || run.intake_closed || run.tasks.length === 0) return []
  if (!run.tasks.every(hasStoppedMoving)) return []
  const escalated = run.tasks.filter((t) => t.phase === 'escalated').map((t) => t.task_id)
  return [
    '  ⚠ every task is settled but intake was never closed — ' +
    (escalated.length === 0
      ? `run \`${hpipe} dispatch --done\` to let this run advance`
      : `run \`${hpipe} dispatch --done\`; the run then still waits on ${escalated.join(', ')} (escalated)`),
  ]
}

/**
 * A finished run stays listed for as long as the session lives, so anything it
 * says is repeated on every `hpipe status`. After live smoke run 2 left one in
 * [done], its orphaned and failed tasks were still listed as "needs a human" an
 * hour later. Measured on a live run.
 *
 * Once the run is over, a per-task rewind is no longer the next step, so none is
 * offered. What stays is one line per task a human may still want: a merged
 * orphan's worktree, which nothing else will remove, and the branch and PR of
 * any task that did not land, which the summary alone would hide.
 */
function finishedRunSummary(run: Run, hpipe: string): string[] {
  const byId = [...run.tasks].sort((a, b) => a.task_id.localeCompare(b.task_id))
  const idsByPhase = new Map<string, string[]>()
  for (const task of byId) {
    idsByPhase.set(task.phase, [...(idsByPhase.get(task.phase) ?? []), task.task_id])
  }
  const outcomes = [...idsByPhase].map(([phase, ids]) => `${phase} ${ids.join(', ')}`).join(' · ')

  const head = wasAborted(run)
    ? [`  aborted from ${run.escalated_from}${outcomes === '' ? '' : `: ${outcomes}`} — ` +
      `\`${hpipe} resume ${run.run_id}\` puts it back`]
    : outcomes === '' ? [] : [`  ended: ${outcomes}`]

  return [...head, ...byId.flatMap((task) => finishedTaskNote(run, task, hpipe))]
}

function finishedTaskNote(run: Run, task: Task, hpipe: string): string[] {
  if (task.phase === 'done' || task.phase === 'blocked-on-failure') return []
  // A manual rewind can put an unmerged task in `orphaned`, and calling its
  // worktree disposable would invite deleting the only copy of its work.
  if (task.phase === 'orphaned' && task.merged_at_ms !== null) {
    const where = task.checkout_path !== null
      ? `at ${task.checkout_path}`
      : `in workspace ${task.workspace_id ?? 'unknown'}`
    return [`  ℹ ${task.task_id} merged but left its worktree ${where} — nothing unmerged is in it`]
  }
  const pr = task.pr === null ? '' : ` PR #${task.pr}`
  return [`  ℹ ${task.task_id} [${task.phase}] ${task.branch}${pr} — ` +
    `\`${hpipe} show --task ${task.task_id} --run ${run.run_id}\``]
}

/**
 * `hpipe` is the rendered invocation from `hpipeCommand`, never a literal: a
 * plugin installed from GitHub has no `hpipe` on PATH, and the digest already
 * renders it, so a literal here would hand the operator a different — and
 * uninvokable — recovery command for the same task.
 */
export function formatStatus(
  runs: Run[], supervisor: StatusSupervisor, session: SessionKey, hpipe: string,
  livePanes: ReadonlySet<string> = new Set(), now: number = Date.now(),
  panes: PaneObservations = {},
): string {
  const holds = panes.holds ?? {}
  const lines: string[] = []
  lines.push(`session: ${session}`)
  lines.push(
    `supervisor: ${supervisor.state}${supervisor.pid ? ` (pid ${supervisor.pid})` : ''}`,
  )
  if (supervisor.state !== 'live') {
    lines.push('  → nothing will advance until a supervisor is running:')
    lines.push('    herdr plugin action invoke stein.pipeline.supervisor')
  }

  if (runs.length === 0) {
    lines.push('no active runs')
    return lines.join('\n')
  }

  for (const run of runs) {
    lines.push('')
    const passes = counterFor(run, run.phase)
    lines.push(
      `${run.run_id}  [${run.phase}]${passes > 0 ? ` pass ${passes}` : ''}  ${run.title}`,
    )
    if (run.orchestrator_pane) lines.push(`  orchestrator: ${run.orchestrator_pane}`)
    if (run.orchestrator_pane && livePanes.size > 0 && !livePanes.has(run.orchestrator_pane)) {
      lines.push(`  ⚠ orchestrator pane ${run.orchestrator_pane} is gone — run the plugin's`)
      lines.push(`    "claim" action from the pane that should drive this run`)
    }

    if (run.schema_version !== 2) {
      lines.push(
        `  ⚠ run ${run.run_id} was started by an earlier plugin version and cannot be ` +
        `advanced — ${hpipe} abort ${run.run_id} to release the repo.`,
      )
    }

    // `phase === 'escalated'`, never `escalated_from !== null`: cmdAbort sets
    // escalated_from and then parks the run in `done` (src/cli.ts:298-299), so
    // the looser predicate would warn about every aborted run.
    if (run.phase === 'escalated') {
      lines.push(
        `  ⚠ run escalated from ${run.escalated_from ?? 'unknown'} ` +
        `${ageMinutes(run.phase_entered_at, now)}m ago — needs a human; ` +
        `\`${resumeCommand(hpipe, run)}\` resumes it`,
      )
    }

    if (runRow(run.phase).terminal === true) {
      lines.push(...finishedRunSummary(run, hpipe))
      continue
    }

    for (const task of run.tasks) {
      const bits = [
        `  ${task.task_id}`,
        task.branch,
        `#${task.issue}`,
        `[${task.phase} ${ageMinutes(task.phase_entered_at, now)}m]`,
        task.agent_status,
      ]
      if (task.pr !== null) bits.push(`PR #${task.pr}`)
      if (task.ci !== null) bits.push(`ci:${task.ci}`)
      lines.push(bits.join(' ') + (run.schema_version === 2 ? taskLineMove(run, task, hpipe, now, holds) : ''))
    }

    if (run.schema_version === 2) {
      lines.push(...intakeWarning(run, hpipe))
      lines.push(...waitingOnYou(run, hpipe, now, holds))
      lines.push(...taskWarnings(run, hpipe, now))
      lines.push(...deliveryWarnings(run, livePanes, now, panes))
    }
  }

  return lines.join('\n')
}

const orNone = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? 'none' : String(value)

const listOrNone = (values: readonly string[]): string =>
  values.length > 0 ? values.join(', ') : 'none'

export function formatTaskDetail(run: Run, task: Task, now: number = Date.now()): string {
  const verdicts = Object.entries(task.artifacts.verdicts)
  const open = openDecisionFor(task)
  return [
    `task:       ${task.task_id}`,
    `run:        ${run.run_id}`,
    `branch:     ${task.branch}`,
    `issue:      #${task.issue}`,
    `surface:    ${task.surface}`,
    `files:      ${listOrNone(task.files)}`,
    `depends on: ${listOrNone(task.depends_on)}`,
    `phase:      ${task.phase} (${ageMinutes(task.phase_entered_at, now)}m)`,
    `agent:      ${task.agent_status}`,
    `workspace:  ${orNone(task.workspace_id)}`,
    `pane:       ${orNone(task.pane_id)}` +
      (task.pane_id === null && task.last_pane_id ? ` (last: ${task.last_pane_id})` : ''),
    `checkout:   ${orNone(task.checkout_path)}`,
    `research:   ${orNone(task.artifacts.research)}`,
    `spec:       ${orNone(task.artifacts.spec)}`,
    `plan:       ${orNone(task.artifacts.plan)}`,
    verdicts.length === 0 ? 'verdicts:   none' : 'verdicts:',
    ...verdicts.map(([key, path]) => `  ${key}: ${path}`),
    `pr:         ${task.pr === null ? 'none' : `#${task.pr}`}`,
    `ci:         ${orNone(task.ci)}`,
    `decision:   ${open === null ? 'none' : `${open.id} — ${open.question}`}`,
    `notes:      ${orNone(task.notes)}`,
  ].join('\n')
}
