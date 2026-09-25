import { abandonDecisions } from '../lib/decisions'
import { isUnlandedSave, runIsDriven } from '../lib/ledger'
import { enterTaskPhase } from '../lib/machine'
import { taskRow } from '../lib/phases'
import { actionFor, ageMinutes, waitsOnYou } from '../lib/status'
import { bindWorkerPane } from '../lib/unstarted'
import type { PaneInfo } from '../lib/herdr'
import type { QueuedEvent, Run, SessionKey, Task, TaskPhase } from '../lib/types'
import { FINISHED } from './teardown'

export interface WakeLine {
  run: Run
  /**
   * Null has no producer today: all three `wake.push` sites set this from
   * `findTask`, which only returns a match. The branch `describeWake` keeps for
   * it is defensive, for a run-level event source that does not exist yet — so
   * `test/tick.test.ts`'s cover for it is a characterisation test, not evidence
   * of behaviour the supervisor can reach. Narrow the type if that stays true.
   */
  task: Task | null
  /**
   * The rendered trigger, ALREADY scoped: `agent:<status>`, `pane exited[, no PR]`,
   * `agent released`. Never a phase completion. The `agent:` prefix is applied here,
   * at push, because the driver keys the blocked-tail gate off it — storing a bare
   * `blocked` makes that gate never match and silently drops the pane tail.
   */
  event: string
  /**
   * The record's phase when this event was applied, before this tick advanced it.
   * Rendered against the LIVE record at delivery time, so a phase this same tick
   * advanced shows as a transition instead of as the phase already left.
   */
  phaseAtEvent: string
  /** Pane tail for a blocked event. Attached by the driver; indented by `describeWake`. */
  detail?: string
}

function phaseBox(phaseAtEvent: string, phase: string, enteredAt: number, now: number): string {
  return phaseAtEvent === phase
    ? `${phase} ${ageMinutes(enteredAt, now)}m`
    : `${phaseAtEvent} → ${phase}`
}

/**
 * One digest line, composed at delivery time from the LIVE record. Every one of
 * the ~50 digests on the berean-os run of 2026-09-16 carried herdr's agent status
 * and nothing else, and every one was followed by `hpipe status`.
 * Measured on a live run.
 */
export function describeWake(line: WakeLine, now: number, hpipe: string): string {
  const { run, task } = line
  if (task === null) {
    const box = phaseBox(line.phaseAtEvent, run.phase, run.phase_entered_at, now)
    return `${run.run_id} [${box}] ${line.event}`
  }

  const box = phaseBox(line.phaseAtEvent, task.phase, task.phase_entered_at, now)
  const head = `${task.task_id} ${task.branch} (#${task.issue}) [${box}] ` +
    `${line.event} — ${actionFor(run, task, hpipe, now)}`
  if (line.detail === undefined || line.detail.length === 0) return head

  const indented = line.detail.split('\n').map((l) => `    ${l}`).join('\n')
  return `${head}\n${indented}`
}

/**
 * Tasks whose row the orchestrator — or a human — owns produce no herdr pane
 * event, so they never reach a digest on their own: t3 sat in `merge` for 4h57m on
 * the berean-os run of 2026-09-16 and emitted zero wake lines. This reports them on
 * digests that are already being sent; it does NOT make them visible in a quiet
 * window, which is #19. Measured on a live run.
 */
export function parkedFooter(
  run: Run, covered: ReadonlySet<string>, now: number, hpipe: string,
): string {
  const parked = run.tasks
    .filter((task) => !covered.has(task.task_id))
    // Dead ends are left to `hpipe status`: they never move again, so the footer
    // would repeat them on every digest for the rest of the run.
    .filter((task) => taskRow(task.phase).terminal !== true && waitsOnYou(run, task, now))
    .sort((a, b) => a.task_id.localeCompare(b.task_id))

  if (parked.length === 0) return ''

  const lines = parked.map((task) =>
    `- ${task.task_id} ${task.branch} (#${task.issue}) ` +
    `[${task.phase} ${ageMinutes(task.phase_entered_at, now)}m] — ${actionFor(run, task, hpipe, now)}`)
  return ['also waiting on you:', ...lines].join('\n')
}

/**
 * Sent in place of the digests an orchestrator missed. Their event lines are not
 * replayed — each described a moment long gone — so this is the ledger now: every
 * task's phase, age and whose move it is, the lines `hpipe status` would give. An
 * orchestrator restarted after the window has no context but this.
 */
export function catchUpDigest(run: Run, now: number, hpipe: string): string {
  const lines = [...run.tasks]
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) =>
      `- ${task.task_id} ${task.branch} (#${task.issue}) ` +
      `[${task.phase} ${ageMinutes(task.phase_entered_at, now)}m] — ${actionFor(run, task, hpipe, now)}`)
  return [
    `catch-up: digests for this run did not reach you, so here is where it stands now ` +
    `(run in ${run.phase} ${ageMinutes(run.phase_entered_at, now)}m):`,
    ...(lines.length === 0 ? ['- no tasks yet'] : lines),
  ].join('\n')
}

export interface ApplyResult {
  changed: boolean
  wake: WakeLine[]
}

/**
 * A pane with no agent left in it is not the worker's pane. Kept, it would make a
 * task rewound out of `failed` look bound, so the unstarted-worker check skipped
 * it and every probe went to a pane that cannot answer.
 */
function releaseWorkerPane(task: Task): void {
  if (task.pane_id !== null) task.last_pane_id = task.pane_id
  task.pane_id = null
  // Nothing reports a status for a pane that is gone, so the last one would be
  // shown for good: t3 read `working` for 50 minutes after its pane was closed.
  // Measured on a live run.
  task.agent_status = 'unknown'
}

/**
 * Whether any phase this task can still reach is one its worker acts in. Past
 * that point — `merge`, `close`, `teardown`, a finished task — closing the
 * worker's pane is cleanup, and failing the task for it would block every task
 * that depends on it for good.
 *
 * A row whose exit is recorded on the task is judged by where it returns: a
 * decision opened in `merge` resumes `merge`, which the worker takes no part in.
 * Only a return target the task never recorded falls back to `resumeActor`.
 */
export function workerStillNeeded(task: Task): boolean {
  const seen = new Set<TaskPhase>()
  const reachable: TaskPhase[] = [task.phase]
  for (let phase = reachable.pop(); phase !== undefined; phase = reachable.pop()) {
    if (seen.has(phase)) continue
    seen.add(phase)
    const row = taskRow(phase)
    if (row.actor === 'worker') return true
    if (row.onClear) reachable.push(row.onClear)
    if (row.onBlocker) reachable.push(row.onBlocker)
    if (row.returnsTo !== undefined) {
      const returnsTo = task[row.returnsTo]
      if (returnsTo) reachable.push(returnsTo)
      else if (row.resumeActor === 'worker') return true
    }
  }
  return false
}

function losePane(run: Run, task: Task, wake: WakeLine[]): void {
  if (!workerStillNeeded(task)) {
    // The answer to an open decision is delivered to the worker's pane, so with
    // that pane gone the question is moot and the task goes back to the row the
    // orchestrator was driving rather than waiting on a delivery that cannot happen.
    if (task.phase === 'blocked-on-decision' && task.decision_from !== null) {
      abandonDecisions(task)
      enterTaskPhase(run, task, task.decision_from, 'worker pane gone; its open decision abandoned')
      task.decision_from = null
    }
    releaseWorkerPane(task)
    return
  }
  const phaseAtEvent = task.phase
  if (task.phase === 'blocked-on-decision') abandonDecisions(task)
  enterTaskPhase(run, task, 'failed', task.pr ? 'pane exited after PR' : 'pane exited with no PR')
  releaseWorkerPane(task)
  wake.push({
    run, task, phaseAtEvent,
    event: `pane exited${task.pr ? '' : ', no PR'}`,
  })
}

/**
 * herdr 0.9.0 emits no `pane.exited` for `herdr pane close` and no `pane.closed`
 * for the panes of a `workspace close`, so a closed worker pane left its task
 * bound to it for 50 minutes. Measured on a live run. This notices such a pane
 * from the supervisor's own `pane list` and reports it as `pane.closed`. A pane
 * must be missing from two successful lists in a row, so one list taken while
 * herdr is mid-change cannot fail a task.
 *
 * A pane moved to another workspace is renamed (`w3:p2` → `w5:p2`) and keeps its
 * `terminal_id`, measured live, so a missing pane whose terminal is still listed
 * is reported as `pane.moved` instead. Terminal ids change across a herdr
 * restart and pane ids do not, so the terminal is only remembered in memory,
 * from the last list that showed the pane.
 */
export class PaneAbsence {
  private missingOnce = new Set<string>()
  private terminalOf = new Map<string, string>()

  reconcile(
    runs: readonly Run[], listed: readonly PaneInfo[], session: SessionKey, now: number,
  ): QueuedEvent[] {
    // An empty list is a failed `pane list`: the supervisor's own pane is always in it.
    if (listed.length === 0) return []
    const live = new Map(listed.map((pane) => [pane.pane_id, pane]))
    const paneOnTerminal = new Map(listed.flatMap((pane) =>
      pane.terminal_id === undefined ? [] : [[pane.terminal_id, pane.pane_id] as const]))

    const bound = runs
      .flatMap((run) => run.tasks)
      .filter((task) => !FINISHED.has(task.phase))
      .flatMap((task) => (task.pane_id === null ? [] : [task.pane_id]))

    const events: QueuedEvent[] = []
    const missing: string[] = []
    const terminalOf = new Map<string, string>()
    for (const pane of bound) {
      const terminal = live.get(pane)?.terminal_id ?? this.terminalOf.get(pane)
      const movedTo = terminal === undefined ? undefined : paneOnTerminal.get(terminal)
      if (live.has(pane)) {
        if (terminal !== undefined) terminalOf.set(pane, terminal)
      } else if (movedTo !== undefined) {
        events.push({ kind: 'pane.moved', session, at: now, pane_id: movedTo, previous_pane_id: pane })
      } else {
        missing.push(pane)
        if (terminal !== undefined) terminalOf.set(pane, terminal)
      }
    }
    this.terminalOf = terminalOf

    for (const pane of missing.filter((p) => this.missingOnce.has(p))) {
      events.push({ kind: 'pane.closed', session, at: now, pane_id: pane })
    }
    this.missingOnce = new Set(missing.filter((pane) => !this.missingOnce.has(pane)))
    return events
  }
}

function findTask(runs: Run[], predicate: (t: Task) => boolean): { run: Run; task: Task } | null {
  for (const run of runs) {
    const task = run.tasks.find(predicate)
    if (task) return { run, task }
  }
  return null
}

export function applyEvents(
  runs: Run[], events: QueuedEvent[], session: SessionKey,
  orchestratorPanes: Set<string>, wakeOn: ReadonlySet<string> = new Set(['blocked', 'done', 'idle']),
): ApplyResult {
  let changed = false
  const wake: WakeLine[] = []

  for (const event of events) {
    if (event.session !== session) continue
    if (event.pane_id && orchestratorPanes.has(event.pane_id)) continue

    // `worktree open` on a checkout that outlived its workspace emits `opened`,
    // never `created`, with the same payload. Captured live on herdr 0.9.0.
    const boundWorktree = event.kind === 'worktree.created' || event.kind === 'worktree.opened'
    if (boundWorktree && event.branch && event.workspace_id) {
      const found = findTask(runs, (t) => t.branch === event.branch && t.workspace_id === null)
      if (found) {
        found.task.workspace_id = event.workspace_id
        found.task.checkout_path = event.checkout_path ?? null
        found.task.adopted_at = Date.now()
        changed = true
      }
      continue
    }

    // Matched on the pane alone: closing a second pane in a worker's workspace
    // says nothing about the worker.
    if (event.kind === 'pane.closed') {
      const found = event.pane_id === undefined
        ? null
        : findTask(runs, (t) => t.pane_id === event.pane_id)
      if (found) {
        losePane(found.run, found.task, wake)
        changed = true
      }
      continue
    }

    if (event.kind === 'pane.moved') {
      const found = event.pane_id === undefined || event.previous_pane_id === undefined
        ? null
        : findTask(runs, (t) => t.pane_id === event.previous_pane_id)
      // herdr also sends it for a move within a workspace, which keeps the id.
      if (found && event.pane_id !== undefined && event.pane_id !== event.previous_pane_id) {
        found.task.pane_id = event.pane_id
        changed = true
      }
      continue
    }

    if (!event.pane_id && !event.workspace_id) continue

    const found = findTask(
      runs,
      (t) =>
        (event.pane_id !== undefined && t.pane_id === event.pane_id) ||
        (event.workspace_id !== undefined && t.workspace_id === event.workspace_id),
    )
    if (!found) continue
    const { run, task } = found
    const phaseAtEvent = task.phase

    if (event.kind === 'pane.agent_detected') {
      if (event.released === true) {
        // A dead pane can never deliver or answer, so its open question is
        // stranded — closing it keeps `hpipe status` and the stall probe honest.
        if (task.phase === 'blocked-on-decision') abandonDecisions(task)
        enterTaskPhase(run, task, 'failed', 'agent released')
        releaseWorkerPane(task)
        wake.push({
          run, task, phaseAtEvent, event: 'agent released',
        })
      } else if (event.pane_id) {
        bindWorkerPane(run, task, event.pane_id, Date.now())
      }
      changed = true
      continue
    }

    if (event.kind === 'pane.exited') {
      losePane(run, task, wake)
      changed = true
      continue
    }

    if (event.kind === 'pane.agent_status_changed' && event.agent_status) {
      if (task.agent_status === event.agent_status) continue
      task.agent_status = event.agent_status
      changed = true
      // Only a positive `working`: a worker goes busy only on something it was
      // given, so this settles a brief `dispatch --task` delivered but could not
      // record. `unknown` is any failed `agent get`, and `blocked` is a boot
      // dialog, so neither proves a brief arrived.
      if (event.agent_status === 'working') delete task.awaiting_brief
      if (wakeOn.has(event.agent_status)) {
        wake.push({
          run, task, phaseAtEvent,
          event: `agent:${event.agent_status}`,
        })
      }
    }
  }

  return { changed, wake }
}

export interface EventSaveDeps {
  save: (run: Run) => Promise<void>
  reload: (run: Run) => Promise<Run | null>
  /** The same drained batch, applied to one freshly read run. */
  reapply: (run: Run) => ApplyResult
  warn: (message: string) => void
}

/**
 * Saves every run after an event batch. A run a CLI command rewrote since this
 * tick read it is re-read and the batch applied again: drain() is destructive, so
 * dropping the save would lose a pane exit or a worktree adoption for good, and
 * saving the tick's copy would silently undo the command (#51). A run that still
 * cannot be saved sits out the rest of the tick, so nothing downstream acts on —
 * or sends prompts about — state the ledger never recorded.
 */
export async function saveEventedRuns(
  runs: Run[], wake: WakeLine[], deps: EventSaveDeps,
): Promise<{ runs: Run[]; wake: WakeLine[] }> {
  const saved: Run[] = []
  let lines = wake

  for (const run of runs) {
    try {
      await deps.save(run)
      saved.push(run)
      continue
    } catch (error) {
      if (!isUnlandedSave(error)) throw error
    }

    lines = lines.filter((line) => line.run !== run)
    try {
      const fresh = await deps.reload(run)
      if (fresh === null) continue
      const replay = deps.reapply(fresh)
      if (replay.changed) await deps.save(fresh)
      saved.push(fresh)
      lines = [...lines, ...replay.wake]
    } catch (error) {
      if (!isUnlandedSave(error)) throw error
      deps.warn(`[pipeline] run ${run.run_id}: events not saved (${error.message}); ` +
        'skipping it this tick')
    }
  }

  return { runs: saved, wake: lines }
}

/**
 * A run held in `execute` by escalated tasks alone has nothing the supervisor can
 * move: only a human's rewind, which the CLI writes, changes it. It stands in for
 * the run-level `escalated` it used to reach, which released the pane, so it must
 * release it too. The escalated tasks' stall probes are drawn from every run, not
 * the picked ones, so the standing nudge survives.
 */
function waitsOnlyOnHumans(run: Run): boolean {
  if (run.phase !== 'execute' || !run.intake_closed) return false
  return run.tasks.some((t) => t.phase === 'escalated') &&
    run.tasks.every((t) => t.phase === 'escalated' || FINISHED.has(t.phase))
}

/**
 * At most one orchestrator-owned advance per orchestrator per tick. Runs in a
 * pane-releasing phase are skipped: their `orchestrator_pane` is never cleared,
 * so without this such a run holds its pane forever and the next `hpipe start`
 * in the same terminal is silently never advanced.
 */
export function pickOneAdvance(runs: Run[]): Run[] {
  const seen = new Set<string>()
  const picked: Run[] = []
  for (const run of runs) {
    if (!runIsDriven(run) || waitsOnlyOnHumans(run)) continue
    const pane = run.orchestrator_pane
    if (!pane || seen.has(pane)) continue
    seen.add(pane)
    picked.push(run)
  }
  return picked
}
