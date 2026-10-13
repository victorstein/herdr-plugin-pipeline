import { existsSync } from 'node:fs'
import { awaitedFor } from './awaiting'
import {
  checkName, checksIn, checkState, fromDecision, gateHead, idList, mergedWithCheckOwed, type OwedCheck, owedAt,
  owedInRun, stateClause,
} from './before-merge'
import { beadOutOfSync } from './bead-desired'
import { escalatedUnanswered, openDecisionFor } from './decisions'
import { landCommand, landsCleanSync, landsUnmergedSync, sha8 } from './batch'
import { CHECK_REL, repoCheck } from './check'
import {
  dispatchUnderWay, type DispatchLocks, NO_DISPATCHES, staleDispatchLock, underWayClause,
} from './dispatch-lock'
import { fileHolders, landingQueue, landingSlotHolder } from './gating'
import { counterFor, FILES_FREE_ON_ARRIVAL } from './machine'
import { BATCH_SCHEMA_VERSION, hasLanded, isCurrentSchemaRun, runIsDriven, wasAborted } from './ledger'
import type { PaneHold } from './delivery-health'
import { deliveryWarnings, limitReset, type PaneObservations, queuedResume, queuedWorkerPrompt } from './outbox'
import { runRow, taskRow, tierOf } from './phases'
import { reviewsSkipped, skipReason } from './review-skip'
import { describeFiles, sharedStatusLine } from './shared-paths'
import { effortSummary } from './tier-prompt'
import type {
  Batch, MissingArtifact, Run, SessionKey, Submission, Task, TaskPhase, TierChange, UncommittedWork,
} from './types'
import {
  briefCommand, dispatchWorkerCommand, overdueUndispatchedWorker, overdueUnstartedWorker,
  remainingDispatchSteps, startWorkerCommand, unbriefedWorker, undispatchedWorker, unstartedWorker,
} from './unstarted'

export interface StatusSupervisor {
  state: 'live' | 'stale' | 'none' | 'other-session'
  pid?: number
  /** The run schemas the live supervisor drives; absent for one that predates batches. */
  schemas?: number[]
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

/** The worker's last idle spell in this phase found uncommitted work, and nothing has been seen since. */
export function currentUncommittedWork(run: Run, task: Task): UncommittedWork | null {
  const work = task.uncommitted_work
  return work !== undefined && work.count > 0 && isCurrentObservation(run, task, work.at)
    ? work
    : null
}

/** `2 uncommitted paths (src/a.ts, src/b.ts)`. */
export function uncommittedSummary(work: UncommittedWork): string {
  const more = work.count > work.sample.length ? ', …' : ''
  const noun = work.count === 1 ? 'path' : 'paths'
  return `${work.count} uncommitted ${noun} (${work.sample.join(', ')}${more})`
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
 *
 * A worker owed a usage-limit resume is the same: idle because it has not yet been
 * told to carry on. Read as idle with nothing, the first digest after the reset told
 * the orchestrator to act on every worker the supervisor had just resumed.
 */
function undeliveredWorkerPrompt(run: Run, task: Task, holds: PaneHolds): Move | null {
  const phasePrompt = queuedWorkerPrompt(run, task)
  const resume = phasePrompt === null ? queuedResume(run, task) : null
  const entry = phasePrompt ?? resume
  if (entry === null) return null
  const what = resume === null ? `its ${task.phase} prompt`
    : resume.kind === 'carry-on' ? 'its nudge to carry on' : 'its resume after Claude\'s usage limit'
  const pane = task.pane_id ?? 'its pane'
  const hold = task.pane_id === null ? undefined : holds[task.pane_id]
  if (hold?.code === 'stuck_input' || entry.last_code === 'stuck_input') {
    return {
      waitsOnYou: true,
      clause: `YOUR move: ${what} is held by text in the input box of ${pane} — ` +
        'submit or clear that text; see the ⚠ stuck input line below',
    }
  }
  if (hold !== undefined || entry.attempts > 0) {
    return {
      waitsOnYou: true,
      clause: `YOUR move: ${what} has not reached ${pane} — see the ⚠ delivery line below`,
    }
  }
  return { waitsOnYou: false, clause: `nothing for you — ${what} is queued for ${pane}` }
}

/**
 * A worker Claude's usage limit stopped. The supervisor resumes it at the reset, so
 * nothing is owed unless the reset could not be read: then only a human knows when
 * it has passed.
 */
function pausedByUsageLimit(task: Task, hpipe: string, holds: PaneHolds): Move | null {
  const hold = task.pane_id === null ? undefined : holds[task.pane_id]
  if (hold?.code !== 'usage_limit') return null
  if (hold.until === null || hold.until === undefined) {
    return {
      waitsOnYou: true,
      clause: "YOUR move: paused by Claude's usage limit, whose reset could not be read — once it has reset, " +
        `\`${hpipe} nudge --task ${task.task_id}\``,
    }
  }
  return {
    waitsOnYou: false,
    clause: `nothing for you — paused by Claude's usage limit, resets ${limitReset(hold)}; the supervisor resumes it then`,
  }
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

/**
 * A dispatch under way for this task is not the orchestrator's lapse, and the
 * advice it would otherwise get — start an agent, hand it the brief — is a step
 * that dispatch is taking now.
 */
function dispatchingNow(run: Run, task: Task, hpipe: string, now: number, dispatches: DispatchLocks): Move | null {
  const owesADispatch = unstartedWorker(run, task) !== null || undispatchedWorker(run, task) !== null ||
    unbriefedWorker(run, task) !== null
  const lock = owesADispatch ? dispatchUnderWay(dispatches, run, task) : null
  return lock === null ? null : { waitsOnYou: false, clause: underWayClause(lock, task, hpipe, now) }
}

function moveFor(
  run: Run, task: Task, hpipe: string, now: number, holds: PaneHolds = {}, dispatches: DispatchLocks = NO_DISPATCHES,
): Move {
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
  const batch = run.batch
  if (batch !== undefined && task.phase === 'land-queue') return landQueueMove(run, task, batch, hpipe)
  if (row.actor === 'orchestrator') {
    const escalated = escalatedUnanswered(task)
    if (escalated !== null) {
      return yours(`decision ${escalated.id} was put to the human ` +
        `${ageMinutes(escalated.escalated_at ?? now, now)}m ago — record their ruling with ` +
        `\`${hpipe} answer --task ${task.task_id} --decision ${escalated.id} --answer "<their ruling>" --by human\``)
    }
    if (batch !== undefined && task.phase === 'merge') {
      return yours(`YOUR move: \`${landCommand(run, task.land_sha ?? '<land sha>')}\` — waiting for ` +
        awaitedFor(run, task))
    }
    const held = task.phase === 'merge' ? owedAt(run, task) : []
    if (held.length > 0) return heldMergeMove(run, task, held, hpipe)
    // A recorded answer is the supervisor's to deliver; the orchestrator has done its part.
    return task.pending_answer === null
      ? yours(`YOUR move: waiting for ${awaitedFor(run, task)}`)
      : notYours(`nothing for you — waiting for ${awaitedFor(run, task)}`)
  }
  if (row.actor === 'worker') {
    const underWay = dispatchingNow(run, task, hpipe, now, dispatches)
    if (underWay) return underWay
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
    // Ahead of the undelivered prompt, which reads any hold as "YOUR move".
    const paused = pausedByUsageLimit(task, hpipe, holds)
    if (paused) return paused
    const undelivered = undeliveredWorkerPrompt(run, task, holds)
    if (undelivered) return undelivered
    // An idle worker that has stopped short otherwise reads exactly like a busy
    // one, and the orchestrator waits on it until the stall ladder's first rung.
    const missing = currentMissingArtifact(run, task)
    if (missing) {
      return yours(`YOUR move: worker idle with nothing at ${missing.path} (${adoptionOutcome(missing)})`)
    }
    const work = currentUncommittedWork(run, task)
    if (work) {
      return yours(`YOUR move: worker idle with ${uncommittedSummary(work)} — \`${hpipe} nudge --task ${task.task_id}\` ` +
        `tells it to commit, push and finish ${task.phase}`)
    }
    const waiters = task.phase === 'sync' ? waitingOn(run, task, 'sync') : ''
    return notYours(`worker's move: ${waiters}waiting for ${awaitedFor(run, task)}`)
  }
  if (task.phase === 'blocked-on-files') {
    // A failed holder keeps its files until a human releases them. An escalated one
    // is not released: it is resumed or abandoned, and the skill says so — a release
    // would let this task implement over files the holder is still changing.
    const holders = fileHolders(run, task)
    const failed = holders.filter((t) => taskRow(t.phase).terminal === true)
    if (failed.length > 0) {
      return yours(`YOUR move: ${failed.map((t) => `\`${hpipe} release --task ${t.task_id}\``).join(', ')}`)
    }
    const escalated = holders.filter((t) => t.phase === 'escalated').map((t) => t.task_id)
    if (escalated.length > 0) {
      return notYours(`nothing for you here — ${escalated.join(', ')} ${escalated.length === 1 ? 'holds' : 'hold'} ` +
        `these files and ${escalated.length === 1 ? 'is' : 'are'} escalated; its own line says how to resume or abandon it`)
    }
    // Every task passes through this gate, and one that only passed through read in its
    // digest exactly like one really waiting. Measured on a live run. No tick is promised:
    // widening from the plan, or a sibling released first onto the same files, can still
    // give it a holder at the gate.
    if (holders.length === 0) {
      return notYours("nothing for you — no task holds its files now; the supervisor's file gate passes it to " +
        'implement unless another task takes them first')
    }
    const named = holders.map((t) => `${t.task_id} (${t.phase})`).join(', ')
    const hold = holders.length === 1 ? 'it holds' : 'they hold'
    return notYours(`nothing for you — waiting for ${named} to free the files ${hold}`)
  }
  return notYours('nothing for you — the supervisor is driving')
}

/** Nobody's move but the human's, unless a check failed on the head that would merge: a fix is the orchestrator's. */
function heldMergeMove(run: Run, task: Task, held: OwedCheck[], hpipe: string): Move {
  const failed = held.find((o) => o.state.kind === 'waiting-on-a-fix')
  if (failed === undefined) {
    return { waitsOnYou: false, clause: `waiting on the human (${idList(held.map((o) => o.check.id))})` }
  }
  return {
    waitsOnYou: true,
    clause: `YOUR move: ${failed.check.id} failed on the head that would merge — ` +
      `\`${hpipe} rewind ${run.run_id} implement --task ${task.task_id}\` sends it back to its worker`,
  }
}

/** "t5, t6 wait on this sync; ": the tasks a slow holder is keeping from landing. */
function waitingOn(run: Run, holder: Task, what: string): string {
  const ids = landingQueue(run.tasks).filter((t) => t !== holder).map((t) => t.task_id)
  return ids.length === 0 ? '' : `${ids.join(', ')} ${ids.length === 1 ? 'waits' : 'wait'} on this ${what}; `
}

/**
 * Nobody's move: the supervisor hands the slot on as soon as it is free. A task
 * with no agent can still land, but not sync, and only the orchestrator can
 * start one for it.
 */
function landQueueMove(run: Run, task: Task, batch: Batch, hpipe: string): Move {
  if (task.pane_id === null) {
    const start = task.workspace_id === null
      ? dispatchWorkerCommand(run, task, hpipe)
      : startWorkerCommand(run, task, task.workspace_id, hpipe)
    return {
      waitsOnYou: false,
      clause: `nothing for you yet — waiting to land; it has no agent, so if ${batch.branch} moves past it, it ` +
        `needs one in its worktree to sync: ${start}`,
    }
  }
  const holder = landingSlotHolder(run.tasks)
  if (holder !== null) {
    const holding = holder.phase === 'blocked-on-decision' ? holder.decision_from ?? holder.phase : holder.phase
    return {
      waitsOnYou: false,
      clause: `nothing for you — waiting to land; ${holder.task_id} holds the landing slot (${holding})`,
    }
  }
  return {
    waitsOnYou: false,
    clause: landingQueue(run.tasks)[0] === task
      ? 'nothing for you yet — next to land; your land prompt comes when it reaches merge'
      : 'nothing for you — waiting to land',
  }
}

/**
 * The digest footer's predicate. It passes no CLI because only the clause needs
 * one, and the footer renders its clause through `actionFor` separately.
 */
export function waitsOnYou(
  run: Run, task: Task, now: number = Date.now(), holds: PaneHolds = {}, dispatches: DispatchLocks = NO_DISPATCHES,
): boolean {
  return moveFor(run, task, '', now, holds, dispatches).waitsOnYou
}

/**
 * Whose move it is, keyed on the phase row rather than the phase name so a row
 * added to TASK_ROWS gets a correct clause with no edit here. Shared by the
 * digest, its parked-task footer and `hpipe status`, so the three cannot hand an
 * operator different recovery commands for the same task.
 */
export function actionFor(
  run: Run, task: Task, hpipe: string, now: number = Date.now(), holds: PaneHolds = {},
  dispatches: DispatchLocks = NO_DISPATCHES,
): string {
  return moveFor(run, task, hpipe, now, holds, dispatches).clause
}

/**
 * A move waiting on you is listed under `waiting on you:`; any other clause
 * printed nowhere, so the grace's "dispatch under way" never showed. Measured on
 * a live run. The grace's full recipe is left to `show`: on a line where nothing
 * is owed yet it only buried the task.
 */
function taskLineMove(
  run: Run, task: Task, hpipe: string, now: number, holds: PaneHolds, dispatches: DispatchLocks,
): string {
  const move = moveFor(run, task, hpipe, now, holds, dispatches)
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
/**
 * A run phase that is the orchestrator's own work. Without it, a run in
 * `branch-review` listed nothing under "waiting on you" while it waited on nobody
 * else. Measured on a live run.
 */
function runMove(run: Run): string | null {
  if (run.phase !== 'branch-review') return null
  return 'YOUR move: the whole-branch review — the branch-review prompt names its verdict path'
}

function waitingOnYou(run: Run, hpipe: string, now: number, holds: PaneHolds, dispatches: DispatchLocks): string[] {
  const byId = [...run.tasks].sort((a, b) => a.task_id.localeCompare(b.task_id))
  const own = runMove(run)
  const runLine = own === null ? [] : [`    run [${run.phase} ${ageMinutes(run.phase_entered_at, now)}m] — ${own}`]
  const lines = [...runLine, ...byId.flatMap((task) => {
    const move = moveFor(run, task, hpipe, now, holds, dispatches)
    if (!move.waitsOnYou) return []
    const age = ageMinutes(task.phase_entered_at, now)
    return [`    ${task.task_id} ${task.branch} (${task.bead}) [${task.phase} ${age}m] — ${move.clause}`]
  })]
  return lines.length === 0 ? [] : ['  waiting on you:', ...lines]
}

/**
 * The checks the human owes at a gate, or past one: a per-task task in `merge`, or
 * merged; a single-PR run in `ship-merge`. Elsewhere nothing waits on them yet, since
 * a ruling is taken only near the gate.
 */
function humanOwesAtTheGate(run: Run): OwedCheck[] {
  const waiting = (owed: OwedCheck[]) => owed.filter((o) => o.state.kind === 'waiting-on-the-human')
  if (run.batch !== undefined) return run.phase === 'ship-merge' ? waiting(owedAt(run, null)) : []
  return run.tasks
    .filter((task) => task.phase === 'merge' || task.merged_at_ms !== null)
    .flatMap((task) => waiting(owedAt(run, task)))
}

/**
 * One line per check the human owes: status's "waiting on the human" block and the
 * digest footer share it. A per-task task whose own hold prompt rides in the digest
 * (`covered`) is not repeated under it.
 */
export function humanWaitLines(
  run: Run, hpipe: string, now: number, covered: ReadonlySet<string> = new Set(),
): string[] {
  return humanOwesAtTheGate(run)
    .filter((o) => o.task === null || run.batch !== undefined || !covered.has(o.task.task_id))
    .map((o) => {
      const where = o.task === null || run.batch !== undefined
        ? `${o.task?.task_id ?? 'run'} [${run.phase} ${ageMinutes(run.phase_entered_at, now)}m]`
        : `${o.task.task_id} [${o.task.phase} ${ageMinutes(o.task.phase_entered_at, now)}m]`
      const pr = run.batch === undefined ? o.task?.pr ?? null : run.batch.pr
      const head = gateHead(run, o.task)
      const build = `${pr === null ? 'its PR' : `PR #${pr}`}${head === null ? '' : ` at ${sha8(head)}`}`
      const last = o.state.kind === 'waiting-on-the-human' ? o.state.last : null
      const since = last === null ? ''
        : ` (${last.as === 'confirmed' ? 'confirmed' : 'failed'} on ${sha8(last.head ?? 'unknown')}; the head is now ` +
          `${sha8(head ?? 'unknown')})`
      return `${o.check.id} ${where} — ${o.check.check}${fromDecision(o.check)}, on ${build}${since} — once they ` +
        `answer: \`${hpipe} confirm --check ${o.check.id} --by human\` (or --waive / --failed)`
    })
}

/** A run that only a ruling can let finish, because a merged task got past its gate with a check owed. */
function backstopLines(run: Run, now: number): string[] {
  if (run.phase !== 'execute') return []
  return mergedWithCheckOwed(run).filter((task) => task.phase !== 'merge').map((task) =>
    `run [execute ${ageMinutes(run.phase_entered_at, now)}m] — ${task.task_id} merged with ` +
    `${idList(owedAt(run, task).map((o) => o.check.id))} owed: confirm or waive it to let the run finish`)
}

function waitingOnTheHuman(run: Run, hpipe: string, now: number): string[] {
  const lines = [...backstopLines(run, now), ...humanWaitLines(run, hpipe, now)]
  return lines.length === 0 ? [] : ['  waiting on the human:', ...lines.map((line) => `    ${line}`)]
}

/** Every check the run has, in either mode, and where each stands. */
function beforeMergeHeader(run: Run): string[] {
  const checks = checksIn(run)
  if (checks.length === 0) return []
  return [`  before merge: ${checks.map((held) =>
    `${checkName(held)} ${held.check.check} — ${stateClause(checkState(run, held))}`).join(' · ')}`]
}

/**
 * Detail the "waiting on you" clause has no room for: the question itself, who
 * holds the files, a stalled answer. Only meaningful once a run is on the
 * current schema.
 */
function taskWarnings(run: Run, hpipe: string, now: number): string[] {
  const lines: string[] = []

  for (const task of run.tasks) {
    if (beadOutOfSync(task)) {
      lines.push(`  ⚠ ${task.task_id} bead ${task.bead} is out of sync after ${task.bead_sync.streak} ` +
        `consecutive failed Beads calls: ${task.bead_sync.last_error}`)
    }

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

    const heldAfterMerge = task.phase === 'merge' && task.merged_at_ms !== null ? owedAt(run, task) : []
    if (heldAfterMerge.length > 0) {
      const ids = idList(heldAfterMerge.map((o) => o.check.id))
      lines.push(`  ⚠ ${task.task_id}: PR #${task.pr ?? 'unknown'} merged before the human confirmed ${ids} — it ` +
        `waits in merge until ${ids} ${heldAfterMerge.length === 1 ? 'is' : 'are'} confirmed or waived`)
    }

    if (task.phase === 'blocked-on-files') {
      for (const holder of fileHolders(run, task)) {
        lines.push(
          `  ⚠ ${task.task_id} blocked on files held by ${holder.task_id} (${holder.phase}) — ` +
          (holder.phase === 'escalated'
            ? 'it keeps them until it is resumed or abandoned'
            : hasStoppedMoving(holder)
              ? 'it has stopped moving, so only a release clears it'
              : 'waiting for it to finish'),
        )
      }
    }
  }

  return lines
}

/** A stale lock changes no advice; it is named so the leftover file is not a mystery. */
function staleDispatchWarning(run: Run, hpipe: string, dispatches: DispatchLocks): string[] {
  const stale = staleDispatchLock(dispatches, run)
  return stale === null ? [] : [`  ⚠ a dispatch lock for this repo is left by pid ${stale.pid}, which is gone; the ` +
    `next \`${hpipe} dispatch\` cleans it up`]
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
  const shipping = run.batch === undefined ? [] : [shippedLine(run, run.batch)]

  const owed = owedInRun(run).map((o) => `  ⚠ ended with ${checkName(o)} still owed to the human: ${o.check.check}`)
  return [...head, ...shipping, ...owed, ...byId.flatMap((task) => finishedTaskNote(run, task, hpipe))]
}

/** A landed task's code reaches the default branch only with the batch PR, so a run that stopped short says so. */
function shippedLine(run: Run, batch: Batch): string {
  if (batch.merged_at_ms !== null) {
    return `  shipped: PR #${batch.pr ?? 'unknown'} squash-merged as ${sha8(batch.merge_commit ?? 'unknown')}`
  }
  const landed = run.tasks.filter((t) => (t.landed ?? []).length > 0).map((t) => t.task_id)
  if (landed.length === 0) return `  not shipped: nothing landed on ${batch.branch}`
  const one = landed.length === 1
  return `  not shipped: ${batch.branch} holds ${landed.length} landed task${one ? '' : 's'} (${landed.join(', ')}) ` +
    `that ${one ? 'is' : 'are'} not on ${batch.into}; ${one ? 'its bead is' : 'their beads are'} closed`
}

function finishedTaskNote(run: Run, task: Task, hpipe: string): string[] {
  if (task.phase === 'done' || task.phase === 'blocked-on-failure') return []
  // A manual rewind can put an unmerged task in `orphaned`, and calling its
  // worktree disposable would invite deleting the only copy of its work.
  if (task.phase === 'orphaned' && hasLanded(task)) {
    const where = task.checkout_path !== null
      ? `at ${task.checkout_path}`
      : `in workspace ${task.workspace_id ?? 'unknown'}`
    const how = run.batch === undefined ? 'merged' : 'landed'
    return [`  ℹ ${task.task_id} ${how} but left its worktree ${where} — nothing un${how} is in it`]
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
  panes: PaneObservations = {}, tools: string | null = null, dispatches: DispatchLocks = NO_DISPATCHES,
): string {
  const holds = panes.holds ?? {}
  const lines: string[] = []
  lines.push(`session: ${session}`)
  lines.push(
    `supervisor: ${supervisor.state}${supervisor.pid ? ` (pid ${supervisor.pid})` : ''}`,
  )
  if (tools !== null) lines.push(tools)
  if (supervisor.state !== 'live') {
    lines.push('  → nothing will advance until a supervisor is running:')
    lines.push('    herdr plugin action invoke stein.pipeline.supervisor')
  }

  if (runs.length === 0) {
    lines.push('no active runs')
    return lines.join('\n')
  }

  // A finished run from an earlier plugin version needs nothing from anyone, and
  // nine of them pushed every live run off the screen of \`hpipe status | head\`.
  // Measured on a live run.
  const finishedLegacy = runs.filter((run) => !isCurrentSchemaRun(run) && run.phase === 'done')
  for (const run of runs.filter((r) => !finishedLegacy.includes(r))) {
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

    // Its tasks predate `bead`, so no task line can be drawn for them.
    if (!isCurrentSchemaRun(run)) {
      lines.push(
        `  ⚠ run ${run.run_id} was started by an earlier plugin version and is ignored here: ` +
        'nothing advances it and it does not hold the repo. Finish it on the release that started it.',
      )
      continue
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
    if (run.batch !== undefined) lines.push(...batchHeader(run, run.batch, supervisor, now, hpipe))
    const shared = sharedStatusLine(run)
    if (shared !== null) lines.push(`  ${shared}`)
    lines.push(...beforeMergeHeader(run))

    for (const task of run.tasks) {
      const bits = [
        `  ${task.task_id}`,
        task.branch,
        task.bead,
        `[${task.phase} ${ageMinutes(task.phase_entered_at, now)}m]`,
        tierOf(task),
        ...(task.review_skip === undefined ? [] : [reviewsSkipped(task.review_skip)]),
        `agent:${task.agent_status}`,
      ]
      if (task.pr !== null) bits.push(`PR #${task.pr}`)
      if (task.ci !== null) bits.push(`ci:${task.ci}`)
      lines.push(bits.join(' ') + taskLineMove(run, task, hpipe, now, holds, dispatches))
    }

    lines.push(...intakeWarning(run, hpipe))
    lines.push(...staleDispatchWarning(run, hpipe, dispatches))
    lines.push(...waitingOnYou(run, hpipe, now, holds, dispatches))
    lines.push(...waitingOnTheHuman(run, hpipe, now))
    lines.push(...taskWarnings(run, hpipe, now))
    lines.push(...deliveryWarnings(run, livePanes, now, panes))
  }

  if (finishedLegacy.length > 0) {
    lines.push('', `${finishedLegacy.length} finished run${finishedLegacy.length === 1 ? '' : 's'} from an earlier ` +
      'plugin version not shown: nothing advances them and they hold nothing')
  }

  return lines.join('\n')
}

function shipLines(run: Run, batch: Batch, hpipe: string): string[] {
  const ci = batch.ci === null ? '' : ` ci:${batch.ci}${batch.ci_head ? ` (on ${sha8(batch.ci_head.sha)})` : ''}`
  const pr = batch.pr === null
    ? '  · final PR: none seen yet — the supervisor records it on its first tick after GitHub lists it'
    : `  · PR #${batch.pr}${ci}`
  if (run.phase === 'ship') {
    return [pr, '  YOUR move: check the batch and open its PR (the ship prompt has the commands)']
  }
  if (run.phase === 'ship-ci') return [pr]
  if (run.phase === 'ship-merge') return [pr, shipMergeMove(run, batch, hpipe)]
  return []
}

function shipMergeMove(run: Run, batch: Batch, hpipe: string): string {
  const pr = `PR #${batch.pr ?? 'unknown'}`
  const owed = owedAt(run, null)
  if (owed.length === 0) return `  YOUR move: squash-merge ${pr} (the ship-merge prompt has the commands)`
  const failed = owed.find((o) => o.state.kind === 'waiting-on-a-fix')
  if (failed?.state.kind === 'waiting-on-a-fix') {
    const ruling = failed.state.ruling
    return `  YOUR move: ${checkName(failed)} failed on ${sha8(ruling.head ?? 'unknown')} (${ruling.note ?? ''}) — ` +
      `fix it on ${batch.branch}: a subagent's patch in the batch checkout, then \`${hpipe} batch-check\`, or a fix ` +
      `task through \`${hpipe} task …\``
  }
  return `  nothing for you — ${pr} waits on the human for ${idList(owed.map((o) => o.check.id))}`
}

/**
 * How a single-PR run ships, on every phase: a landing is invisible on the default
 * branch until the batch PR merges, and nothing else in status would say where it is.
 */
/**
 * Where to read what the batch declares: a task checkout cut from it, or the batch
 * checkout, before the user's working copy, which may sit on any branch.
 */
function batchLineage(run: Run, batch: Batch): string {
  const checkouts = [...run.tasks.map((t) => t.checkout_path), batch.checkout]
  return checkouts.find((path): path is string => path !== null && existsSync(path)) ?? run.repo_root
}

const PAST_ITS_LAST_LANDING: ReadonlySet<string> = new Set<TaskPhase>(['close', 'teardown', 'done'])

/**
 * A task counts from its first landing, so one taking a later commit back through
 * review is named: "3 of 3 landed" alone read as nothing left. Measured on a live run.
 */
function landedCount(run: Run): string {
  const landed = run.tasks.filter((t) => (t.landed ?? []).length > 0)
  const more = landed
    .filter((t) => !PAST_ITS_LAST_LANDING.has(t.phase) && taskRow(t.phase).terminal !== true)
    .map((t) => t.task_id)
  const still = more.length === 0 ? '' : `, ${more.join(', ')} ${more.length === 1 ? 'has' : 'have'} more to land`
  return `${landed.length} of ${run.tasks.length} landed${still}`
}

function batchHeader(run: Run, batch: Batch, supervisor: StatusSupervisor, now: number, hpipe: string): string[] {
  const holder = landingSlotHolder(run.tasks)
  const next = landingQueue(run.tasks).map((t) => t.task_id)
  const header = [
    `  ships as one PR: ${batch.branch} → ${batch.into}`,
    landedCount(run),
    ...(holder === null ? [] : [`landing: ${holder.task_id} (${holder.phase})`]),
    ...(next.length === 0 ? [] : [`next: ${next.join(', ')}`]),
  ].join(' · ')
  const warnings: string[] = []
  if (repoCheck(batchLineage(run, batch)).kind === 'none') {
    warnings.push(`  ⚠ no ${CHECK_REL} in this repo: each landing is checked only by its worker's own test run`)
  }
  if (batch.fetch_error) {
    warnings.push(`  ⚠ ${batch.branch} has not fetched for ${ageMinutes(batch.fetch_error.since, now)}m ` +
      `(${batch.fetch_error.reason}): landings are not being seen`)
  }
  if (supervisor.state === 'live' && !(supervisor.schemas ?? [3]).includes(BATCH_SCHEMA_VERSION)) {
    warnings.push(`  ⚠ the running supervisor (pid ${supervisor.pid ?? 'unknown'}) predates single-PR runs and ignores ` +
      "this run: close its Pipeline supervisor pane and run the plugin's supervisor action")
  }
  return [header, ...warnings, ...shipLines(run, batch, hpipe)]
}

/**
 * A skipped review shows here by its absence. Tier changes are not read from
 * `run.history` because they are never written there; see `TierChange`.
 */
export function visitedPhases(run: Run, task: Task): string[] {
  const visited: string[] = []
  let previous: string | undefined
  for (const entry of run.history) {
    if (entry.task_id !== task.task_id) continue
    const passedTheGate = entry.from === 'blocked-on-files' && entry.why === FILES_FREE_ON_ARRIVAL
    if (passedTheGate && visited.at(-1) === 'blocked-on-files') {
      visited[visited.length - 1] = 'blocked-on-files (passed through)'
    }
    // A rewind onto the phase the task is already in is still a rewind worth showing.
    if (entry.from !== 'rewind' && entry.to === previous) continue
    previous = entry.to
    visited.push(entry.from === 'rewind' ? `↺${entry.to}` : entry.to)
  }
  return visited
}

function tierLogEntry(change: TierChange): string {
  const when = `${new Date(change.at).toISOString().slice(0, 16).replace('T', ' ')}Z`
  const move = `${change.from ?? '—'} → ${change.to}`
  return change.from === null
    ? `${when} ${move} (${change.why})`
    : `${when} ${move} (${change.source}, pane ${change.pane ?? 'unknown'}): ${change.why}`
}

const orNone = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? 'none' : String(value)

const listOrNone = (values: readonly string[]): string =>
  values.length > 0 ? values.join(', ') : 'none'

/**
 * A sync carries the change's title forward from its first submission, so the title
 * beside a sync's sha read as that commit's own. Measured on a live run.
 */
function submittedLine(sub: Submission, batch: Batch, now: number): string {
  const checked = sub.check === 'passed' ? 'check passed' : 'no check declared'
  const at = `at ${sha8(sub.head_sha)}, ${ageMinutes(sub.at, now)}m ago`
  if (sub.kind !== 'sync') return `${sub.title} (${sub.kind}, ${at}; ${checked})`
  const merge = sub.merge !== 'clean'
    ? `not a clean merge of ${batch.branch}, at ${sha8(sub.dirty_at ?? sub.head_sha)}`
    : sub.merges === 0 ? `nothing on ${batch.branch} to merge` : `a clean merge of ${batch.branch}`
  return `sync ${at} (${merge}; ${checked})`
}

function landingDetail(task: Task, batch: Batch, now: number): string[] {
  const sub = task.submission
  const submitted = sub === undefined ? 'none' : submittedLine(sub, batch, now)
  const judged = task.review_skip === undefined ? 'reviewed' : `submitted; ${reviewsSkipped(task.review_skip)}`
  const landed = landsUnmergedSync(task) ? `${judged}; its sync merged nothing`
    : landsCleanSync(task) ? `clean sync of ${batch.branch}` : judged
  const landSha = task.land_sha ? `${sha8(task.land_sha)} (${landed})` : 'none'
  const landings = (task.landed ?? []).map((l) => {
    const skipped = l.review_skipped === undefined ? '' : ` (${l.review_skipped.join(' and ')} skipped)`
    return `${batch.branch} at ${sha8(l.land_sha)}, ${ageMinutes(l.at, now)}m ago${skipped}`
  })
  return [
    `pr:         none (single-PR run: lands on ${batch.branch})`,
    `submitted:  ${submitted}`,
    `land sha:   ${landSha}`,
    ...(landings.length === 0 ? ['landed:     none'] : landings.map((l) => `landed:     ${l}`)),
    'ci:         n/a — CI runs once, on the batch PR',
  ]
}

/** Teardown keeps the path on the record, so `show` printed it as if it were still there. */
function checkoutGone(task: Task): boolean {
  const finished = task.phase === 'done' || taskRow(task.phase).terminal === true
  return finished && task.checkout_path !== null && !existsSync(task.checkout_path)
}

export function formatTaskDetail(run: Run, task: Task, now: number = Date.now()): string {
  const verdicts = Object.entries(task.artifacts.verdicts)
  const open = openDecisionFor(task)
  const tierLog = (task.tier_history ?? []).map(tierLogEntry)
  const visited = visitedPhases(run, task)
  return [
    `task:       ${task.task_id}`,
    `run:        ${run.run_id}`,
    `branch:     ${task.branch}`,
    `bead:       ${task.bead}`,
    `surface:    ${task.surface}`,
    `files:      ${describeFiles(run, task.files)}`,
    `depends on: ${listOrNone(task.depends_on)}`,
    `phase:      ${task.phase} (${ageMinutes(task.phase_entered_at, now)}m)`,
    `tier:       ${tierOf(task)}`,
    `effort:     ${effortSummary(task)}`,
    `tier log:   ${tierLog.length > 0 ? tierLog.join(' · ') : 'none'}`,
    `visited:    ${visited.length > 0 ? visited.join(' → ') : 'none'}`,
    ...(task.review_skip === undefined ? [] : [
      `skipped:    ${task.review_skip.skipped.join(' and ')} (${skipReason(task.review_skip)})`,
    ]),
    `agent:      ${task.agent_status}`,
    `workspace:  ${orNone(task.workspace_id)}`,
    `pane:       ${orNone(task.pane_id)}` +
      (task.pane_id === null && task.last_pane_id ? ` (last: ${task.last_pane_id})` : ''),
    `checkout:   ${orNone(task.checkout_path)}${checkoutGone(task) ? ' (removed)' : ''}`,
    `research:   ${orNone(task.artifacts.research)}`,
    `spec:       ${orNone(task.artifacts.spec)}`,
    `plan:       ${orNone(task.artifacts.plan)}`,
    verdicts.length === 0 ? 'verdicts:   none' : 'verdicts:',
    ...verdicts.map(([key, path]) => `  ${key}: ${path}`),
    ...(run.batch === undefined ? [
      `pr:         ${task.pr === null ? 'none' : `#${task.pr}`}`,
      `ci:         ${orNone(task.ci)}${task.ci !== null && task.ci_head ? ` (on ${sha8(task.ci_head.sha)})` : ''}`,
    ] : landingDetail(task, run.batch, now)),
    `decision:   ${open === null ? 'none' : `${open.id} — ${open.question}`}`,
    ...beforeMergeDetail(run, task, now),
    `notes:      ${orNone(task.notes)}`,
  ].join('\n')
}

const BEFORE_MERGE_LABEL = 'before merge: '

function beforeMergeDetail(run: Run, task: Task, now: number): string[] {
  return (task.before_merge ?? []).map((check, i) => {
    const state = checkState(run, { check, task })
    const label = i === 0 ? BEFORE_MERGE_LABEL : ' '.repeat(BEFORE_MERGE_LABEL.length)
    return `${label}${check.id} ${check.check}${fromDecision(check)} — ${stateClause(state, now)}`
  })
}
