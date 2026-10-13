import { existsSync } from 'node:fs'
import { checkoutSteps, sha8 } from './batch'
import { runIsDriven, taskPhaseIsTerminal } from './ledger'
import { modeOf } from './phases'
import type { Batch, BeforeMergeCheck, Resolution, Run, Task } from './types'

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

/** Every check the run still owes the human, at whichever gate it holds. */
export function owedInRun(run: Run): OwedCheck[] {
  if (modeOf(run) === 'single-pr') return owedAt(run, null)
  return run.tasks.flatMap((task) => owedAt(run, task))
}

/** What keeps a per-task run's `execute` from finishing, whatever route took a merged task past its gate. */
export function mergedWithCheckOwed(run: Run): Task[] {
  if (modeOf(run) !== 'per-task') return []
  return run.tasks.filter((task) => task.merged_at_ms !== null && owedAt(run, task).length > 0)
}

/** The newest ruling that failed one of this task's checks, which sent it back to its worker. */
export function lastFailure(task: Task): { check: BeforeMergeCheck; ruling: Resolution } | null {
  let found: { check: BeforeMergeCheck; ruling: Resolution } | null = null
  for (const check of task.before_merge ?? []) {
    const ruling = check.resolutions.at(-1)
    if (ruling?.as === 'failed' && (found === null || ruling.at >= found.ruling.at)) found = { check, ruling }
  }
  return found
}

const headName = (head: string | null): string => (head === null ? 'no recorded head' : sha8(head))

const minutesSince = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / 60_000))

export const checkName = (held: HeldCheck): string =>
  (held.task === null ? held.check.id : `${held.check.id} (${held.task.task_id})`)

/** `c1 (t1)` for a single-PR task check, whose gate is the run's; a per-task gate holds one task's checks only. */
const gateLabel = (run: Run, held: HeldCheck): string =>
  (modeOf(run) === 'single-pr' ? checkName(held) : held.check.id)

export const fromDecision = (check: BeforeMergeCheck): string =>
  (check.decision === undefined ? '' : ` (from ${check.decision})`)

/** Where a check stands, in the words status, show and the notices share. With `now`, each ruling is dated. */
export function stateClause(state: CheckState, now?: number): string {
  const ago = (at: number): string => (now === undefined ? '' : `, ${minutesSince(at, now)}m ago`)
  switch (state.kind) {
    case 'not-needed':
      return `not needed: ${state.why}`
    case 'confirmed':
      return `confirmed by the human${state.ruling.head === null ? '' : ` on ${sha8(state.ruling.head)}`}${ago(state.ruling.at)}`
    case 'waived':
      return `waived by the human${now === undefined ? '' : ` ${minutesSince(state.ruling.at, now)}m ago`}: ` +
        (state.ruling.note ?? '')
    case 'waiting-on-a-fix':
      return `failed on ${headName(state.ruling.head)}${ago(state.ruling.at)}: ${state.ruling.note ?? ''}; waiting on a fix`
    case 'waiting-on-the-human': {
      const last = state.last
      if (last === null) return 'waiting on the human'
      if (last.as === 'confirmed') {
        return `confirmed on ${headName(last.head)}${ago(last.at)}, but the head is now ${headName(state.headNow)}: ` +
          'waiting on the human'
      }
      return `failed on ${headName(last.head)}${ago(last.at)}: ${last.note ?? ''}; the human checks the next head`
    }
  }
}

/** What the gate prompt says beside an owed check: what has changed since the human last ruled. */
function sinceLastRuling(state: OwedState): string {
  if (state.kind === 'waiting-on-a-fix') {
    return ` — failed on ${headName(state.ruling.head)}: ${state.ruling.note ?? ''}; waiting on a fix`
  }
  const last = state.last
  if (last === null) return ''
  return last.as === 'confirmed'
    ? ` — confirmed on ${headName(last.head)}; the head is now ${headName(state.headNow)}`
    : ` — failed on ${headName(last.head)}: ${last.note ?? ''}; the fix is in, so the new head is checked again`
}

function owedLines(run: Run, owed: OwedCheck[]): string {
  return owed.map((o) => `- ${gateLabel(run, o)}: ${o.check.check}${fromDecision(o.check)}${sinceLastRuling(o.state)}`)
    .join('\n')
}

const BUILD_INDENT = '       '

function perTaskMergeable(pr: string): string {
  return [
    'Ask GitHub where the PR stands:',
    '',
    `${BUILD_INDENT}gh pr view ${pr} --json mergeStateStatus`,
    '',
    '   - `UNKNOWN`: GitHub is still computing it. Ask again a few seconds later, at most three times; if it is',
    '     still `UNKNOWN`, go on as for `CLEAN`, and say so to the human.',
    '   - `CLEAN`, `UNSTABLE` or `HAS_HOOKS`: it is mergeable. Go to step 2.',
    '   - `BEHIND` or `DIRTY`: rebase the branch onto the default branch and push, then re-run',
    "     `./.claude/pipeline-bootstrap` in that checkout if the repo declares one. The new head sends the task",
    '     back to `ci`, and this prompt comes again for it: do not ask the human until then.',
    ...sharedMergeableCases(pr),
  ].join('\n')
}

function batchMergeable(pr: string, batch: Batch): string {
  return [
    'Ask GitHub where the PR stands:',
    '',
    `${BUILD_INDENT}gh pr view ${pr} --json mergeStateStatus`,
    '',
    '   - `UNKNOWN`: GitHub is still computing it. Ask again a few seconds later, at most three times; if it is',
    '     still `UNKNOWN`, go on as for `CLEAN`, and say so to the human.',
    '   - `CLEAN`, `UNSTABLE` or `HAS_HOOKS`: it is mergeable. Go to step 2.',
    `   - \`BEHIND\`: \`gh pr update-branch ${pr}\`. \`DIRTY\`: merge \`origin/${batch.into}\` into the batch checkout, as`,
    "     the ship prompt's step 2 does, resolve, and push. Either moves the head, so the run goes back through",
    '     `ship`, and the human checks the head that reaches this prompt again.',
    ...sharedMergeableCases(pr),
  ].join('\n')
}

function sharedMergeableCases(pr: string): string[] {
  return [
    '   - `BLOCKED`: a required review or a required check. Name it from',
    `     \`gh pr view ${pr} --json reviewDecision,statusCheckRollup\`. A required review can go in the same message`,
    '     to the human; a required check that never ran is fixed before you ask.',
    `   - \`DRAFT\`: \`gh pr ready ${pr}\`, which moves no head, then ask again.`,
  ]
}

function batchBuild(run: Run, batch: Batch, head: string | null): string {
  const what = head === null
    ? `\`${batch.branch}\` as it stands now: no CI pass is recorded on it.`
    : `\`${batch.branch}\` at ${sha8(head)}, the head CI passed on.`
  const steps = checkoutSteps(run, existsSync(batch.checkout)).map((step) => `${BUILD_INDENT}${step}`)
  return `${what} If you build it for them, build it in the batch checkout, brought up to date:\n\n${steps.join('\n')}`
}

function failedRoute(run: Run, owed: OwedCheck[], hpipe: string): string {
  const failed = owed.flatMap((o) => (o.state.kind === 'waiting-on-a-fix'
    ? [`${gateLabel(run, o)} failed on ${headName(o.state.ruling.head)}`]
    : []))
  if (failed.length === 0) return ''
  return `\n\n${failed.join(' and ')}, so this hold also waits on a fix, and the fix is yours, before step 2: ` +
    `a subagent's patch in the batch checkout, then \`${hpipe} batch-check\`; or a fix task through ` +
    `\`${hpipe} task …\`, which moves the run back to \`execute\`, then \`${hpipe} dispatch --done\`. Either moves ` +
    'the head, and the human checks the new head when this prompt comes again.'
}

/** The gate prompt's own bag. Its tokens are `held_`-prefixed: a task's common bag already has a `subject`. */
export function holdPromptVars(run: Run, task: Task | null, owed: OwedCheck[], hpipe: string): Record<string, string> {
  const head = gateHead(run, task)
  const batch = run.batch
  if (task === null && batch !== undefined) {
    const pr = String(batch.pr ?? 'unknown')
    return {
      held_title: `the batch PR #${pr}`,
      held_line: `PR #${pr}, \`${batch.branch}\` into \`${batch.into}\`,`,
      held_checks: owedLines(run, owed),
      held_mergeable: batchMergeable(pr, batch),
      held_build: batchBuild(run, batch, head),
      held_failed_route: failedRoute(run, owed, hpipe),
    }
  }
  const pr = String(task?.pr ?? 'unknown')
  return {
    held_title: `PR #${pr} (${task?.branch ?? 'unknown'}, ${task?.bead ?? 'unknown'})`,
    held_line: `PR #${pr}`,
    held_checks: owedLines(run, owed),
    held_mergeable: perTaskMergeable(pr),
    held_build: head === null
      ? `PR #${pr} as it stands now: no CI pass is recorded on it.`
      : `PR #${pr} at ${sha8(head)}, the head CI passed on.`,
    held_failed_route: '',
  }
}

/** `{{before_merge}}` of ship-merge.md: what the human ruled, once nothing is owed. */
export function rulingsNote(run: Run): string {
  const rulings = checksIn(run).map((held) => `${checkName(held)} ${stateClause(checkState(run, held))}`)
  return rulings.length === 0 ? '' : `\n\nBefore merge: ${rulings.join('; ')}.`
}

/** `{{before_merge}}` of answer.md: the checks this answer carried, which the worker makes checkable. */
export function answerCheckNote(run: Run, task: Task, decisionId: string): string {
  const carried = (task.before_merge ?? []).filter((check) => check.decision === decisionId)
  if (carried.length === 0) return ''
  const place = modeOf(run) === 'single-pr' ? 'the message of an empty commit on the branch' : 'the PR body'
  return ['', '', 'Before this merges, the human will check:', '', ...carried.map((check) => `- ${check.check}`), '',
    `Make it checkable: say in ${place} how to check it.`].join('\n')
}

/** check-failed.md's own variables, beside the task's common bag. */
export function checkFailedVars(failure: { check: BeforeMergeCheck; ruling: Resolution }): Record<string, string> {
  return {
    failed_check: failure.check.check,
    failed_from: fromDecision(failure.check),
    failed_seen: failure.ruling.note ?? '',
    failed_head: headName(failure.ruling.head),
  }
}
