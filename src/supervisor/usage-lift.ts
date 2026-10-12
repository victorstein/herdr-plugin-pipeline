import { isUnlandedSave, type RunEffect, type SaveOutcome } from '../lib/ledger'
import { isAgentReady } from '../lib/machine'
import { enqueue, isCurrent, probeRecipient, queuedResume, queuedWorkerPrompt } from '../lib/outbox'
import { runRow, taskRow } from '../lib/phases'
import { render } from '../lib/render'
import type { Run, Task, TaskPhase } from '../lib/types'
import { unbriefedWorker } from '../lib/unstarted'
import { warnToTick } from './deliver'
import { actorPaneFor } from './stall'
import { type LimitIO, type PaneLimit, readLimit, resetText, type UsageLimits } from './usage-limits'

export interface Lift {
  pane: string
  limit: PaneLimit
  /** The pane is still idle with the limit line last, and Claude won't continue it on its own. */
  resume: boolean
}

export interface LiftTexts {
  /** By task id: the resume text and the phase it was rendered for. */
  resume: ReadonlyMap<string, { phase: TaskPhase; text: string }>
  /** `usage-lifted.md`, unrendered: the effect has to stay synchronous. */
  note: string
  hpipe: string
}

const OWN_SESSION = ' It stopped your own session too: pick up what you were doing when it hit.'

/**
 * The lift as a `RunEffect`, decided against whichever copy it is applied to, so a
 * save that loses to a CLI write replays it onto the fresh copy correctly. Returns
 * the lifted panes the run touched; none means the run was left alone.
 *
 * Every record whose stall recipient or actor is a lifted pane starts its ladder
 * again: its probes went unanswered because of the limit, not the agent. A worker
 * is told to carry on only when it is provably still where the limit stopped it;
 * otherwise a phase prompt, a nudge, Claude's own auto-continue or its new phase
 * restarts it, and a resume on top would restart the phase's subagents twice.
 */
export function liftEffect(lifts: readonly Lift[], texts: LiftTexts, now: number): (run: Run) => Set<string> {
  const byPane = new Map(lifts.map((l) => [l.pane, l]))
  return (run) => {
    const touched = new Set<string>()
    const records: Array<[Run | Task, Task | null]> = [[run, null], ...run.tasks.map((t): [Task, Task] => [t, t])]
    for (const [record, task] of records) {
      const row = task === null ? runRow(run.phase) : taskRow(task.phase)
      const lifted = [probeRecipient(run, task), actorPaneFor(run, row, task)]
        .filter((pane): pane is string => pane !== null && byPane.has(pane))
      if (lifted.length === 0) continue
      record.stall = {
        at: record.phase_entered_at, run_at: run.phase_entered_at, last_probe_at: now, probes: 0, undelivered: 0, holds: 0,
      }
      for (const pane of lifted) touched.add(pane)
    }

    const resumed: Array<{ task: Task; lift: Lift }> = []
    for (const task of run.tasks) {
      const lift = task.pane_id === null ? undefined : byPane.get(task.pane_id)
      const rendered = texts.resume.get(task.task_id)
      if (lift === undefined) continue
      touched.add(lift.pane)
      if (rendered === undefined || !mayResume(run, task, lift, rendered.phase)) continue
      enqueue(run, { to: 'worker', taskId: task.task_id, text: rendered.text, kind: 'resume' }, now)
      resumed.push({ task, lift })
    }

    const orchestratorLift = run.orchestrator_pane === null ? undefined : byPane.get(run.orchestrator_pane)
    if (orchestratorLift !== undefined) touched.add(orchestratorLift.pane)
    const own = orchestratorLift?.resume === true
    if ((resumed.length > 0 || own) && !noteQueued(run)) {
      const resets = [...new Set([...(own ? [orchestratorLift] : []), ...resumed.map((r) => r.lift)]
        .flatMap((lift) => (lift === undefined ? [] : [resetText(lift.limit.line)]))
        .filter((reset): reset is string => reset !== null))]
      enqueue(run, {
        to: 'orchestrator', taskId: null, kind: 'resume',
        text: render(texts.note, {
          run_id: run.run_id,
          reset: resets.length === 0 ? '' : ` (it was due at ${resets.join(', ')})`,
          own: own ? OWN_SESSION : '',
          resumed: resumed.length === 0 ? '' : ' Told to carry on where they stopped, their stall clocks restarted: ' +
            `${resumed.map(({ task }) => `${task.task_id} (${task.phase})`).join(', ')}.`,
          hpipe: texts.hpipe,
        }),
      }, now)
    }
    return touched
  }
}

function mayResume(run: Run, task: Task, lift: Lift, renderedFor: TaskPhase): boolean {
  return lift.resume &&
    taskRow(task.phase).actor === 'worker' &&
    task.phase_entered_at <= lift.limit.since &&
    task.phase === renderedFor &&
    queuedWorkerPrompt(run, task) === null &&
    queuedResume(run, task) === null &&
    unbriefedWorker(run, task) === null
}

function noteQueued(run: Run): boolean {
  return (run.outbox ?? []).some((entry) => entry.to === 'orchestrator' && entry.kind === 'resume' && isCurrent(run, entry))
}

export interface LiftDeps {
  io: LimitIO
  /** `saveOrReapply` with the one effect. */
  save: (run: Run, effect: RunEffect) => Promise<SaveOutcome>
  renderResume: (task: Task) => Promise<string>
  note: () => Promise<string>
  hpipe: string
  now: () => number
  log?: (message: string) => void
}

/**
 * The tick's lift step, run after delivery and before the stall step. Each due
 * pane is read once for the resume guard; each run it touches is saved with the
 * lift as its effect. A pane is lifted only once every run it touches has landed
 * that save, so a failed save leaves it limited and the lift is tried again next
 * tick. Returns the runs whose tick copy is now stale, for the stall step to skip.
 */
export async function liftLimits(limits: UsageLimits, runs: readonly Run[], deps: LiftDeps): Promise<Set<Run>> {
  const stale = new Set<Run>()
  const due = limits.due()
  if (due.length === 0) return stale

  const lifts = await Promise.all(due.flatMap((pane) => {
    const limit = limits.get(pane)
    return limit === undefined ? [] : [readLimit(deps.io, pane).then((reading): Lift => ({
      pane, limit,
      resume: limit.release !== 'moved-on' && reading !== null && isAgentReady(reading.status) &&
        reading.line !== null && !reading.autoContinue,
    }))]
  }))
  const duePanes = new Set(due)
  const note = await deps.note()
  const failed = new Set<string>()
  const log = deps.log ?? warnToTick

  for (const run of runs) {
    const resume = new Map<string, { phase: TaskPhase; text: string }>()
    for (const task of run.tasks) {
      if (task.pane_id === null || !duePanes.has(task.pane_id) || taskRow(task.phase).actor !== 'worker') continue
      resume.set(task.task_id, { phase: task.phase, text: await deps.renderResume(task) })
    }
    const effect = liftEffect(lifts, { resume, note, hpipe: deps.hpipe }, deps.now())
    const touched = effect(run)
    if (touched.size === 0) continue
    try {
      if (await deps.save(run, (fresh) => { effect(fresh) }) === 'reapplied') stale.add(run)
    } catch (error) {
      if (!isUnlandedSave(error)) throw error
      stale.add(run)
      for (const pane of touched) failed.add(pane)
      log(`run ${run.run_id}: usage-limit lift not saved (${error.message}); tried again next tick`)
    }
  }

  for (const pane of due) if (!failed.has(pane)) limits.lifted(pane)
  return stale
}
