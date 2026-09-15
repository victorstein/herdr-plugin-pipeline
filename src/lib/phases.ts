export type RunPhase =
  | 'intake' | 'dispatch' | 'execute' | 'branch-review' | 'escalated' | 'done'

export type Actor = 'orchestrator' | 'worker' | 'human'

export type Signal =
  | 'artifact' | 'verdict' | 'pr' | 'ci' | 'merged' | 'closed'
  | 'worktree' | 'registration' | 'gate' | 'files' | 'manual'

export interface PhaseRow<P extends string> {
  phase: P
  /** Whose pane produces this phase's completion signal. Absent = nobody's. */
  actor?: Actor
  signal: Signal
  /** Which artifact slot this row's freshness predicate reads. */
  artifact?: 'research' | 'spec' | 'plan'
  onClear?: P
  onBlocker?: P
  /** Dynamic return target, for rows whose exit is recorded on the record. */
  returnsTo?: 'decision_from' | 'escalated_from'
  /**
   * The key this row increments on a backward transition. Required on every row
   * with an `onBlocker`; asserted by table.test.ts. Monotone — nothing resets it
   * but `hpipe rewind`.
   */
  counter?: P
  prompt?: string
  /** Prompt sent to `resumeActor` when this row is left, not when it is entered. */
  resumePrompt?: string
  resumeActor?: 'orchestrator' | 'worker'
  stallable?: boolean
  /** Required when `actor` resolves to no pane and the row is stallable. */
  probeTarget?: 'orchestrator'
  holdsFiles?: boolean | 'inherit'
  terminal?: boolean
  releasesPane?: boolean
}

export const RUN_ROWS: readonly PhaseRow<RunPhase>[] = [
  { phase: 'intake', actor: 'orchestrator', signal: 'registration',
    onClear: 'dispatch', prompt: 'intake' },
  { phase: 'dispatch', actor: 'orchestrator', signal: 'worktree',
    onClear: 'execute', prompt: 'dispatch', stallable: true },
  { phase: 'execute', signal: 'gate',
    onClear: 'branch-review', stallable: true, probeTarget: 'orchestrator' },
  { phase: 'branch-review', actor: 'orchestrator', signal: 'verdict',
    onClear: 'done', onBlocker: 'branch-review', counter: 'branch-review',
    prompt: 'branch-review', stallable: true },
  { phase: 'escalated', actor: 'human', signal: 'manual',
    returnsTo: 'escalated_from', prompt: 'escalate', releasesPane: true },
  { phase: 'done', signal: 'manual', terminal: true, releasesPane: true },
]

const RUN_BY_PHASE = new Map(RUN_ROWS.map((r) => [r.phase, r]))

export function runRow(phase: RunPhase): PhaseRow<RunPhase> {
  const row = RUN_BY_PHASE.get(phase)
  if (!row) throw new Error(`no run row for phase: ${phase}`)
  return row
}

export type TaskPhase =
  | 'queued' | 'research' | 'spec' | 'spec-review' | 'plan' | 'plan-review'
  | 'blocked-on-files' | 'implement' | 'pr-review-intent' | 'pr-review-quality'
  | 'ci' | 'merge' | 'close' | 'teardown' | 'blocked-on-decision'
  | 'escalated' | 'failed' | 'orphaned' | 'blocked-on-failure' | 'done'

export const TASK_ROWS: readonly PhaseRow<TaskPhase>[] = [
  { phase: 'queued', signal: 'gate', onClear: 'research', holdsFiles: false },

  { phase: 'research', actor: 'worker', signal: 'artifact', artifact: 'research',
    onClear: 'spec', prompt: 'research', stallable: true, holdsFiles: false },
  { phase: 'spec', actor: 'worker', signal: 'artifact', artifact: 'spec',
    onClear: 'spec-review', prompt: 'spec', stallable: true, holdsFiles: false },
  { phase: 'spec-review', actor: 'worker', signal: 'verdict',
    onClear: 'plan', onBlocker: 'spec', counter: 'spec-review',
    prompt: 'spec-review', stallable: true, holdsFiles: false },
  { phase: 'plan', actor: 'worker', signal: 'artifact', artifact: 'plan',
    onClear: 'plan-review', prompt: 'plan', stallable: true, holdsFiles: false },
  { phase: 'plan-review', actor: 'worker', signal: 'verdict',
    onClear: 'blocked-on-files', onBlocker: 'plan', counter: 'plan-review',
    prompt: 'plan-review', stallable: true, holdsFiles: false },

  { phase: 'blocked-on-files', signal: 'files', onClear: 'implement',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: false },

  // A worker whose pane hangs without emitting `pane.exited` goes unnoticed
  // otherwise; this is the one task-level probe that ships today.
  { phase: 'implement', actor: 'worker', signal: 'pr',
    onClear: 'pr-review-intent', prompt: 'implement', stallable: true, holdsFiles: true },
  { phase: 'pr-review-intent', actor: 'worker', signal: 'verdict',
    onClear: 'pr-review-quality', onBlocker: 'implement', counter: 'pr-review-intent',
    prompt: 'pr-review-intent', stallable: true, holdsFiles: true },
  { phase: 'pr-review-quality', actor: 'worker', signal: 'verdict',
    onClear: 'ci', onBlocker: 'implement', counter: 'pr-review-quality',
    prompt: 'pr-review-quality', stallable: true, holdsFiles: true },

  { phase: 'ci', signal: 'ci', onClear: 'merge', onBlocker: 'implement',
    counter: 'ci', prompt: 'ci-red', holdsFiles: true },
  { phase: 'merge', actor: 'orchestrator', signal: 'merged',
    onClear: 'close', prompt: 'merge', holdsFiles: true },
  { phase: 'close', actor: 'orchestrator', signal: 'closed',
    onClear: 'teardown', prompt: 'close', holdsFiles: true },
  { phase: 'teardown', signal: 'worktree', onClear: 'done', holdsFiles: true },

  { phase: 'blocked-on-decision', actor: 'orchestrator', signal: 'manual',
    returnsTo: 'decision_from', prompt: 'decision',
    resumePrompt: 'answer', resumeActor: 'worker',
    stallable: true, holdsFiles: 'inherit' },
  { phase: 'escalated', actor: 'human', signal: 'manual',
    returnsTo: 'escalated_from', prompt: 'escalate', holdsFiles: true },

  { phase: 'failed', signal: 'manual', terminal: true, holdsFiles: true },
  { phase: 'orphaned', signal: 'manual', terminal: true, holdsFiles: false },
  { phase: 'blocked-on-failure', signal: 'manual', terminal: true, holdsFiles: false },
  { phase: 'done', signal: 'manual', terminal: true, holdsFiles: false },
]

const TASK_BY_PHASE = new Map(TASK_ROWS.map((r) => [r.phase, r]))

export function taskRow(phase: TaskPhase): PhaseRow<TaskPhase> {
  const row = TASK_BY_PHASE.get(phase)
  if (!row) throw new Error(`no task row for phase: ${phase}`)
  return row
}
