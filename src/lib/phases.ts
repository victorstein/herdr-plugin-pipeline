export type RunPhase =
  | 'intake' | 'dispatch' | 'execute' | 'branch-review' | 'escalated' | 'done'

export type Actor = 'orchestrator' | 'worker' | 'supervisor' | 'human'

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
  resumeActor?: Actor
  stallable?: boolean
  /** Required when `actor` resolves to no pane and the row is stallable. */
  probeTarget?: 'orchestrator'
  terminal?: boolean
  releasesPane?: boolean
}

export const RUN_ROWS: readonly PhaseRow<RunPhase>[] = [
  { phase: 'intake', actor: 'orchestrator', signal: 'registration',
    onClear: 'dispatch', prompt: 'intake', stallable: true },
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
