export type RunPhase =
  | 'intake' | 'dispatch' | 'execute' | 'branch-review' | 'ship' | 'ship-ci' | 'ship-merge'
  | 'escalated' | 'done'

export type Actor = 'orchestrator' | 'worker' | 'human'

export type Signal =
  | 'artifact' | 'verdict' | 'pr' | 'ci' | 'merged' | 'closed'
  | 'worktree' | 'registration' | 'gate' | 'files' | 'manual' | 'slot' | 'synced'

/** Ordered lightest first: `isLowering` reads the order. */
export type Tier = 'light' | 'standard' | 'heavy'

export const TIERS: readonly Tier[] = ['light', 'standard', 'heavy']

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value)
}

/**
 * Structural, like `stallWhen`, to keep this module free of a types.ts import. A
 * task from a ledger written before tiers existed ran every review, and keeps
 * doing so across an upgrade; the default is never written back.
 */
export function tierOf(task: { tier?: Tier }): Tier {
  return task.tier ?? 'heavy'
}

/** How a run ships: one PR per task, or every task landed on a batch branch that ships as one PR. */
export type RunMode = 'per-task' | 'single-pr'

/** Structural for the same reason as `tierOf`: a run is single-PR exactly when it carries a batch. */
export function modeOf(run: { batch?: unknown }): RunMode {
  return run.batch === undefined || run.batch === null ? 'per-task' : 'single-pr'
}

export function modeName(mode: RunMode): string {
  return mode === 'single-pr' ? 'single-PR' : 'per-task'
}

/** What decides a task's route through the table: its tier picks the reviews, its run's mode the last mile. */
export interface TaskRoute {
  tier: Tier
  mode: RunMode
}

export function routeOf(run: { batch?: unknown }, task: { tier?: Tier }): TaskRoute {
  return { tier: tierOf(task), mode: modeOf(run) }
}

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
  /**
   * Extra condition for a stallable row that is healthy while it waits. Without
   * it, `execute` is probed 15 minutes into every run — during the phase where
   * the orchestrator is busiest — which is the false alarm v4's third review
   * round removed. Structurally typed to keep this module free of a types.ts
   * import, which would cycle.
   */
  stallWhen?: (run: { intake_closed: boolean; tasks: readonly { phase: string }[] }) => boolean
  /** Required when `actor` resolves to no pane and the row is stallable. */
  probeTarget?: 'orchestrator'
  holdsFiles?: boolean | 'inherit'
  terminal?: boolean
  releasesPane?: boolean
  /**
   * The tiers that run this row; absent means every tier, and empty means a
   * retired row that a task already in it still leaves by its route. Never set on
   * a row that is any row's `onBlocker`, so blocker routing stays tier-blind —
   * asserted by table.test.ts.
   */
  tiers?: readonly Tier[]
  /**
   * The run modes that run this row; absent means both. A row carrying it is the
   * `onBlocker` only of rows whose own modes are a subset — asserted by
   * table.test.ts — so no mode is ever sent back onto a row it skips.
   */
  modes?: readonly RunMode[]
  /**
   * The row needs none of its worker's context, so a fresh agent in the same
   * worktree can take it over: a pane lost here, or before it, releases the pane
   * rather than failing the task.
   */
  anyWorker?: boolean
}

const TERMINAL_OR_SETTLED: ReadonlySet<string> = new Set([
  'done', 'failed', 'orphaned', 'blocked-on-failure', 'escalated',
])

export const RUN_ROWS: readonly PhaseRow<RunPhase>[] = [
  { phase: 'intake', actor: 'orchestrator', signal: 'registration',
    onClear: 'dispatch', prompt: 'intake' },
  { phase: 'dispatch', actor: 'orchestrator', signal: 'worktree',
    onClear: 'execute', prompt: 'dispatch', stallable: true },
  { phase: 'execute', signal: 'gate', onClear: 'branch-review',
    stallable: true, probeTarget: 'orchestrator',
    stallWhen: (run) => !run.intake_closed && run.tasks.length > 0 &&
      run.tasks.every((t) => TERMINAL_OR_SETTLED.has(t.phase)) },
  // Unlike the other review rows, this one loops back onto itself: by the time
  // it runs every task has finished, so there is no producer phase
  // to return to. The orchestrator patches the branch directly, and the counter
  // still bounds the loop.
  { phase: 'branch-review', actor: 'orchestrator', signal: 'verdict',
    onClear: 'ship', onBlocker: 'branch-review', counter: 'branch-review',
    prompt: 'branch-review', stallable: true },
  { phase: 'ship', actor: 'orchestrator', signal: 'pr', onClear: 'ship-ci',
    prompt: 'ship', stallable: true, modes: ['single-pr'] },
  { phase: 'ship-ci', signal: 'ci', onClear: 'ship-merge', onBlocker: 'ship', counter: 'ship-ci',
    stallable: true, probeTarget: 'orchestrator', modes: ['single-pr'] },
  { phase: 'ship-merge', actor: 'orchestrator', signal: 'merged', onClear: 'done',
    prompt: 'ship-merge', stallable: true, modes: ['single-pr'] },
  // Both release the orchestrator pane: neither clears `orchestrator_pane`, and
  // both need a human (`hpipe rewind`/`abort`) to leave, so either would
  // otherwise starve the next run started in that same terminal.
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

export function rowRunsIn(row: PhaseRow<string>, mode: RunMode): boolean {
  return row.modes === undefined || row.modes.includes(mode)
}

/** Where a cleared run row goes in this mode: along `onClear`, past every row the mode skips. */
export function nextRunPhase(mode: RunMode, from: PhaseRow<RunPhase>): RunPhase {
  for (let phase = from.onClear; phase !== undefined; phase = runRow(phase).onClear) {
    if (rowRunsIn(runRow(phase), mode)) return phase
  }
  throw new Error(`no ${mode} run row after ${from.phase}: the table runs out`)
}

export type TaskPhase =
  | 'queued' | 'research' | 'spec' | 'spec-review' | 'plan' | 'plan-review'
  | 'blocked-on-files' | 'implement' | 'pr-review' | 'pr-review-intent' | 'pr-review-quality'
  | 'ci' | 'land-queue' | 'sync' | 'merge' | 'close' | 'teardown' | 'blocked-on-decision'
  | 'escalated' | 'failed' | 'orphaned' | 'blocked-on-failure' | 'done'

/**
 * A single-PR task's rows from its last review to its landing: the slot, the batch
 * fetch, the machine's landing edges and a rewind's reviewed head all key on them.
 */
export const LANDING_PHASES: ReadonlySet<string> = new Set<TaskPhase>(['land-queue', 'sync', 'merge'])

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
    prompt: 'plan-review', stallable: true, holdsFiles: false, tiers: ['standard', 'heavy'] },

  { phase: 'blocked-on-files', signal: 'files', onClear: 'implement',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: false },

  // A worker whose pane hangs without emitting `pane.exited` goes unnoticed otherwise.
  { phase: 'implement', actor: 'worker', signal: 'pr',
    onClear: 'pr-review', prompt: 'implement', stallable: true, holdsFiles: true },
  // One review for every tier. Heavy's split pair cleared 66 of 66 intent reviews,
  // and the only PR-stage defect in 254 berean-os verdicts came from this combined
  // review, so the second pass over one diff bought nothing. Measured on live runs.
  { phase: 'pr-review', actor: 'worker', signal: 'verdict',
    onClear: 'ci', onBlocker: 'implement', counter: 'pr-review',
    prompt: 'pr-review', stallable: true, holdsFiles: true },
  // No route enters these two any more. They stay so a task already in one when
  // the plugin is upgraded finishes it, and leaves for what follows the PR review.
  { phase: 'pr-review-intent', actor: 'worker', signal: 'verdict',
    onClear: 'pr-review-quality', onBlocker: 'implement', counter: 'pr-review-intent',
    prompt: 'pr-review-intent', stallable: true, holdsFiles: true, tiers: [] },
  { phase: 'pr-review-quality', actor: 'worker', signal: 'verdict',
    onClear: 'ci', onBlocker: 'implement', counter: 'pr-review-quality',
    prompt: 'pr-review-quality', stallable: true, holdsFiles: true, tiers: [] },

  // #19. Each waits on something outside the pipeline — GitHub, or a person — and
  // none of their signals is escalatable, so each is nudged forever and can never
  // cascade a dependent. t3 sat in `merge` for 4h57m emitting nothing.
  // Measured on a live run.
  { phase: 'ci', signal: 'ci', onClear: 'land-queue', onBlocker: 'implement',
    counter: 'ci', prompt: 'ci-red', stallable: true, probeTarget: 'orchestrator',
    holdsFiles: true, modes: ['per-task'] },
  // A single-PR task lands one at a time, and only once it contains every landing
  // before it. The slot is derived from phases each tick, never stored, so a crash
  // or a rewind can at worst leave two holders, which costs one refused push.
  { phase: 'land-queue', signal: 'slot', onClear: 'sync', stallable: true,
    probeTarget: 'orchestrator', holdsFiles: true, modes: ['single-pr'] },
  { phase: 'sync', actor: 'worker', signal: 'synced', onClear: 'merge', prompt: 'sync',
    stallable: true, holdsFiles: true, anyWorker: true, modes: ['single-pr'] },
  { phase: 'merge', actor: 'orchestrator', signal: 'merged',
    onClear: 'close', prompt: 'merge', stallable: true, holdsFiles: true },
  // The supervisor's own row: the reconciler closes the bead once the merge is
  // recorded, so nobody is prompted and the probe goes to the orchestrator.
  { phase: 'close', signal: 'closed', onClear: 'teardown',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: true },
  // Teardown is unconditional and runs first (tasks.ts:137), so a task still here
  // past the threshold means this run is not being advanced at all.
  { phase: 'teardown', signal: 'worktree', onClear: 'done',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: true },

  { phase: 'blocked-on-decision', actor: 'orchestrator', signal: 'manual',
    returnsTo: 'decision_from', prompt: 'decision',
    resumePrompt: 'answer', resumeActor: 'worker',
    stallable: true, holdsFiles: 'inherit' },
  // probeTarget because a human owns no pane: table.test.ts:33 counts only
  // `orchestrator` and `worker` as resolving to one.
  { phase: 'escalated', actor: 'human', signal: 'manual',
    returnsTo: 'escalated_from', prompt: 'escalate',
    stallable: true, probeTarget: 'orchestrator', holdsFiles: true },

  // `failed` and `escalated` both leave a worktree holding unmerged work, and
  // nothing ever tears an escalated task down — releasing their files would let
  // a second task be dispatched onto them. `orphaned` is only reachable after
  // merge, so that code has already landed and its files are free.
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

/**
 * Where a cleared row goes on this route: along `onClear`, past every row the
 * tier or the mode skips. Every forward step past `research` reads it, so a tier
 * change needs no special case — the next step simply reads the current tier.
 */
export function nextPhase(route: TaskRoute, from: PhaseRow<TaskPhase>): TaskPhase {
  for (let phase = from.onClear; phase !== undefined; phase = taskRow(phase).onClear) {
    const row = taskRow(phase)
    const inTier = row.tiers === undefined || row.tiers.includes(route.tier)
    if (inTier && rowRunsIn(row, route.mode)) return phase
  }
  throw new Error(`no ${route.tier} ${route.mode} row after ${from.phase}: the table runs out`)
}
