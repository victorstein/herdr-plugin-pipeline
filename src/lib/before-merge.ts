import { runIsDriven, taskPhaseIsTerminal } from './ledger'
import { modeOf } from './phases'
import type { BeforeMergeCheck, Resolution, Run, Task } from './types'

/**
 * Every rule about what a before-merge check still owes lives here. The machine, the
 * stall ladder, status, the bead and the CLI all read these functions, so they cannot
 * disagree about whether a merge is held.
 */

export interface HeldCheck {
  check: BeforeMergeCheck
  /** Null for a run check. */
  task: Task | null
}

export type CheckState =
  | { kind: 'not-needed'; why: string }
  | { kind: 'confirmed'; ruling: Resolution }
  | { kind: 'waived'; ruling: Resolution }
  /** `last` is a ruling on a head that is no longer the gate head, if there was one. */
  | { kind: 'waiting-on-the-human'; last: Resolution | null; headNow: string | null }
  | { kind: 'waiting-on-a-fix'; ruling: Resolution }

export type OwedState = Extract<CheckState, { kind: 'waiting-on-the-human' | 'waiting-on-a-fix' }>

export interface OwedCheck extends HeldCheck {
  state: OwedState
}

const idNumber = (id: string): number => Number(id.slice(1))

export function checksIn(run: Run): HeldCheck[] {
  return [
    ...run.tasks.flatMap((task) => (task.before_merge ?? []).map((check) => ({ check, task }))),
    ...(run.before_merge ?? []).map((check) => ({ check, task: null })),
  ].sort((a, b) => idNumber(a.check.id) - idNumber(b.check.id))
}

/** Nothing ever deletes a check, so the count only grows and an id is never reused. */
export const nextCheckId = (run: Run): string => `c${checksIn(run).length + 1}`

export function findCheck(run: Run, id: string): HeldCheck | null {
  return checksIn(run).find((held) => held.check.id === id) ?? null
}

/**
 * The head the gate row merges: the head CI passed on. A single-PR task check holds
 * the batch PR, not the task's landing, so it is judged on the batch's head.
 */
export function gateHead(run: Run, task: Task | null): string | null {
  if (modeOf(run) === 'single-pr') return run.batch?.ci_head?.sha ?? null
  return task?.ci_head?.sha ?? null
}

/** A check whose work never ships has nothing left to check. Computed, so a resume brings it back. */
function whyNotNeeded(run: Run, { task }: HeldCheck): string | null {
  if (task === null) return null
  if (modeOf(run) === 'single-pr') {
    const shipping = run.phase === 'ship-merge' || run.phase === 'done'
    return shipping && (task.landed ?? []).length === 0 ? `${task.task_id} never landed` : null
  }
  return taskPhaseIsTerminal(task.phase) && task.merged_at_ms === null ? `${task.task_id} never merged` : null
}

/**
 * A confirmation holds only while its head is the one that merges, as a CI pass does;
 * with no gate head, which only a manual rewind past CI leaves, it is taken as given.
 */
export function checkState(run: Run, held: HeldCheck): CheckState {
  const why = whyNotNeeded(run, held)
  if (why !== null) return { kind: 'not-needed', why }
  const last = held.check.resolutions.at(-1) ?? null
  const head = gateHead(run, held.task)
  if (last === null) return { kind: 'waiting-on-the-human', last: null, headNow: head }
  if (last.as === 'waived') return { kind: 'waived', ruling: last }
  if (last.as === 'confirmed') {
    return head === null || last.head === head
      ? { kind: 'confirmed', ruling: last }
      : { kind: 'waiting-on-the-human', last, headNow: head }
  }
  return last.head === head ? { kind: 'waiting-on-a-fix', ruling: last } : { kind: 'waiting-on-the-human', last, headNow: head }
}

export const isOwed = (state: CheckState): state is OwedState =>
  state.kind === 'waiting-on-the-human' || state.kind === 'waiting-on-a-fix'

function owedAmong(run: Run, held: HeldCheck[]): OwedCheck[] {
  return held.flatMap((h) => {
    const state = checkState(run, h)
    return isOwed(state) ? [{ ...h, state }] : []
  })
}

/**
 * The checks owed at a gate: a per-task task's `merge` (task), or a single-PR run's
 * `ship-merge` (null). A single-PR task's landing is never held: one landing at a
 * time means a hold there would stop every landing behind it for as long as the
 * human takes.
 */
export function owedAt(run: Run, task: Task | null): OwedCheck[] {
  const singlePr = modeOf(run) === 'single-pr'
  if (task === null) return singlePr ? owedAmong(run, checksIn(run)) : []
  if (singlePr) return []
  return owedAmong(run, (task.before_merge ?? []).map((check) => ({ check, task })))
}

export function waitsOnlyOnTheHuman(run: Run, task: Task | null): boolean {
  const owed = owedAt(run, task)
  return owed.length > 0 && owed.every((o) => o.state.kind === 'waiting-on-the-human')
}

/**
 * An aborted or escalated run is driving nothing, so its merged tasks' beads close as
 * usual and the run's own record keeps what is owed.
 */
export function heldForTheHuman(run: Run, task: Task): boolean {
  return modeOf(run) === 'per-task' && task.phase === 'merge' && runIsDriven(run) && owedAt(run, task).length > 0
}

/** What keeps a per-task run's `execute` from finishing, whatever route took a merged task past its gate. */
export function mergedWithCheckOwed(run: Run): Task[] {
  if (modeOf(run) !== 'per-task') return []
  return run.tasks.filter((task) => task.merged_at_ms !== null && owedAt(run, task).length > 0)
}
