import type { VerdictResult } from './predicates'
import type { Run, RunPhase, Task, TaskPhase } from './types'

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
  const passes = run.pass + 1
  enterRunPhase(run, back, `review returned BLOCKER (pass ${run.pass})`)
  run.pass = passes
  return run
}

export function enterTaskPhase(run: Run, task: Task, phase: TaskPhase, why: string): Task {
  run.history.push({ at: Date.now(), task_id: task.task_id, from: task.phase, to: phase, why })
  if (phase === 'escalated') task.escalated_from = task.phase
  task.phase = phase
  task.phase_entered_at = Date.now()
  return task
}
