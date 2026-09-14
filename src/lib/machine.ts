import type { VerdictResult } from './predicates'
import type { CiBucket, Run, RunPhase, Task, TaskPhase } from './types'

export interface RunSignals {
  actorIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  maxPasses: number
}

/** Phases whose completion signal is an artifact file. */
export const ARTIFACT_RUN_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  'spec', 'spec-review', 'plan', 'plan-review', 'branch-review',
])

/** A run in one of these needs no further automatic advancement. */
export const COMPLETED_RUN_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(['done'])

/**
 * A run in one of these must not hold an orchestrator pane slot: neither clears
 * `orchestrator_pane`, and both need a human (`hpipe rewind`/`abort`) to leave,
 * so either would starve the next run started in that same terminal.
 */
export const PANE_RELEASING_RUN_PHASES: ReadonlySet<RunPhase> =
  new Set<RunPhase>(['done', 'escalated'])

const REVIEW_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  'spec-review', 'plan-review', 'branch-review',
])

const ON_CLEAR: Partial<Record<RunPhase, RunPhase>> = {
  spec: 'spec-review',
  'spec-review': 'plan',
  plan: 'plan-review',
  'plan-review': 'dispatch',
  'branch-review': 'done',
}

const ON_BLOCKER: Partial<Record<RunPhase, RunPhase>> = {
  'spec-review': 'spec',
  'plan-review': 'plan',
  // Unlike its siblings, branch-review routes to itself: by this point every
  // task is merged and torn down, so there is no producer phase to return to.
  // The orchestrator patches the branch directly and writes a fresh review,
  // and MAX_PASSES still bounds the loop.
  'branch-review': 'branch-review',
}

export function enterRunPhase(run: Run, phase: RunPhase, why: string): Run {
  run.history.push({ at: Date.now(), from: run.phase, to: phase, why })
  if (phase === 'escalated') run.escalated_from = run.phase
  run.phase = phase
  run.phase_entered_at = Date.now()
  return run
}

export function advanceRun(run: Run, signals: RunSignals): Run | null {
  if (!ARTIFACT_RUN_PHASES.has(run.phase)) return null
  if (!signals.actorIdle || !signals.artifactFresh) return null

  if (!REVIEW_PHASES.has(run.phase)) {
    const next = ON_CLEAR[run.phase]
    return next ? enterRunPhase(run, next, 'actor idle + artifact fresh') : null
  }

  if (!signals.verdict) return null

  if (signals.verdict.verdict === 'CLEAR') {
    const next = ON_CLEAR[run.phase]
    return next ? enterRunPhase(run, next, 'review cleared') : null
  }

  if (run.pass >= signals.maxPasses) {
    return enterRunPhase(run, 'escalated', `${run.pass} passes without clearing`)
  }

  const back = ON_BLOCKER[run.phase]
  if (!back) return null
  enterRunPhase(run, back, `review returned BLOCKER (pass ${run.pass})`)
  run.pass += 1
  return run
}

export function enterTaskPhase(run: Run, task: Task, phase: TaskPhase, why: string): Task {
  run.history.push({ at: Date.now(), task_id: task.task_id, from: task.phase, to: phase, why })
  if (phase === 'escalated') task.escalated_from = task.phase
  task.phase = phase
  task.phase_entered_at = Date.now()
  return task
}

export interface TaskSignals {
  actorIdle: boolean
  workerIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  prNumber: number | null
  headSha: string | null
  merged: boolean
  mergedAtMs?: number
  issueClosed: boolean
  closedAtMs?: number
  ciBucket: CiBucket | null
  maxPasses: number
}

const TASK_REVIEW_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'task-review-spec', 'task-review-quality',
])

export function advanceTask(run: Run, task: Task, s: TaskSignals): Task | null {
  switch (task.phase) {
    case 'execute': {
      // Edge, not level: the PR must have moved since this phase was entered.
      const moved = s.headSha !== null && s.headSha !== task.head_sha_at_entry
      if (!s.workerIdle || s.prNumber === null || !moved) return null
      task.pr = s.prNumber
      return enterTaskPhase(run, task, 'task-review-spec', `PR #${s.prNumber} at ${s.headSha}`)
    }

    case 'task-review-spec':
    case 'task-review-quality': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null

      if (s.verdict.verdict === 'CLEAR') {
        const next: TaskPhase = task.phase === 'task-review-spec' ? 'task-review-quality' : 'ci'
        return enterTaskPhase(run, task, next, 'review cleared')
      }

      if (task.pass >= s.maxPasses) {
        return enterTaskPhase(run, task, 'escalated', `${task.pass} passes without clearing`)
      }

      enterTaskPhase(run, task, 'execute', `review returned BLOCKER (pass ${task.pass})`)
      task.pass += 1
      task.head_sha_at_entry = s.headSha
      return task
    }

    case 'ci': {
      if (s.ciBucket === 'pass') return enterTaskPhase(run, task, 'merge', 'CI green')
      if (s.ciBucket === 'fail') {
        // CI retries draw on the same budget as review retries. Without this the
        // task cycles execute → review → ci → execute forever, bypassing the one
        // safety valve the module has.
        if (task.pass >= s.maxPasses) {
          return enterTaskPhase(run, task, 'escalated', `CI still red after ${task.pass} passes`)
        }
        enterTaskPhase(run, task, 'execute', 'CI red')
        task.pass += 1
        task.head_sha_at_entry = s.headSha
        return task
      }
      return null
    }

    case 'merge': {
      if (!s.merged) return null
      if (s.mergedAtMs === undefined || s.mergedAtMs <= task.phase_entered_at) return null
      return enterTaskPhase(run, task, 'close', 'PR merged')
    }

    case 'close': {
      if (!s.issueClosed) return null
      if (s.closedAtMs === undefined || s.closedAtMs <= task.phase_entered_at) return null
      return enterTaskPhase(run, task, 'teardown', `issue #${task.issue} closed`)
    }

    default:
      return null
  }
}
