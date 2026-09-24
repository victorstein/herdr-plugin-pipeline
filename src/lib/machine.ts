import { type PhaseRow, taskRow } from './phases'
import type { VerdictResult } from './predicates'
import type { AgentStatus, CiBucket, Run, RunPhase, Task, TaskPhase } from './types'

interface HasPasses { passes: Record<string, number | undefined> }

export function counterFor(record: HasPasses, phase: string): number {
  return record.passes[phase] ?? 0
}

/**
 * Monotone by construction. Nothing in this module decrements or deletes a
 * counter — only `hpipe rewind` clears the map. Two earlier drafts reset on a
 * forward transition and each time deleted a bound: the review loop in one, the
 * shipped CI retry budget in the other.
 */
export function bumpCounter(record: HasPasses, phase: string): number {
  const next = counterFor(record, phase) + 1
  record.passes[phase] = next
  return next
}

/**
 * An agent has finished its turn. herdr reports `done` for "idle and not yet
 * seen", which is the normal resting state for an agent this plugin drives —
 * nothing human ever looks at it — so `done` must count as ready alongside
 * `idle`. Both the orchestrator and worker paths read this one predicate so the
 * two cannot drift apart again.
 */
export function isAgentReady(status: AgentStatus): boolean {
  return status === 'idle' || status === 'done'
}

export interface RunSignals {
  actorIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  maxPasses: number
  newestRegisteredAt: number | null
  dispatchComplete: boolean
  tasksAllTerminal: boolean
  anyTaskDone: boolean
}

export function enterRunPhase(run: Run, phase: RunPhase, why: string): Run {
  run.history.push({ at: Date.now(), from: run.phase, to: phase, why })
  if (phase === 'escalated') run.escalated_from = run.phase
  run.phase = phase
  run.phase_entered_at = Date.now()
  return run
}

export function advanceRun(run: Run, s: RunSignals): Run | null {
  switch (run.phase) {
    case 'intake': {
      if (!s.actorIdle) return null
      if (s.newestRegisteredAt === null || s.newestRegisteredAt <= run.phase_entered_at) return null
      return enterRunPhase(run, 'dispatch', 'a task was registered')
    }

    // A level, not an edge. As "a worktree adopted after this phase began" it
    // missed adoptions that came first — the orchestrator dispatches from the
    // brief `hpipe task` prints, before intake's idle gate lets the run in here —
    // and the run sat in `dispatch` for good. Measured on a live run. A rewind
    // into this row now leaves again as soon as nothing is owed a worktree.
    case 'dispatch': {
      if (!s.dispatchComplete) return null
      return enterRunPhase(run, 'execute', 'every dispatched task has a worktree')
    }

    case 'execute': {
      if (!run.intake_closed || !s.tasksAllTerminal) return null
      return s.anyTaskDone
        ? enterRunPhase(run, 'branch-review', 'every task finished')
        : enterRunPhase(run, 'escalated', 'every task finished without one reaching done')
    }

    case 'branch-review': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null
      if (s.verdict.verdict === 'CLEAR') return enterRunPhase(run, 'done', 'review cleared')
      const count = bumpCounter(run, 'branch-review')
      if (count >= s.maxPasses) {
        return enterRunPhase(run, 'escalated', `${count} passes without clearing`)
      }
      return enterRunPhase(run, 'branch-review', `review returned BLOCKER (pass ${count})`)
    }

    default:
      return null
  }
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
  artifactFresh: boolean
  verdict: VerdictResult | null
  prNumber: number | null
  headSha: string | null
  merged: boolean
  mergedAtMs?: number
  issueClosed: boolean
  closedAtMs?: number
  filesClear: boolean
  ciBucket: CiBucket | null
  maxPasses: number
}

function advanceLoopingRow(
  run: Run, task: Task, row: PhaseRow<TaskPhase>, cleared: boolean,
  maxPasses: number, headSha: string | null,
): Task | null {
  if (cleared) {
    return enterTaskPhase(run, task, row.onClear as TaskPhase, 'cleared')
  }
  const count = bumpCounter(task, row.phase)
  if (count >= maxPasses) {
    return enterTaskPhase(run, task, 'escalated', `${count} passes at ${row.phase}`)
  }
  enterTaskPhase(run, task, row.onBlocker as TaskPhase, `returned (pass ${count})`)
  if (task.phase === 'implement') task.head_sha_at_entry = headSha
  return task
}

export function advanceTask(run: Run, task: Task, s: TaskSignals): Task | null {
  switch (task.phase) {
    case 'research':
    case 'spec':
    case 'plan': {
      if (!s.actorIdle || !s.artifactFresh) return null
      return enterTaskPhase(
        run, task, taskRow(task.phase).onClear as TaskPhase, 'actor idle + artifact fresh',
      )
    }

    case 'implement': {
      const moved = s.headSha !== null && s.headSha !== task.head_sha_at_entry
      if (!s.actorIdle || s.prNumber === null || !moved) return null
      task.pr = s.prNumber
      return enterTaskPhase(run, task, 'pr-review-intent', `PR #${s.prNumber} at ${s.headSha}`)
    }

    case 'spec-review':
    case 'plan-review':
    case 'pr-review-intent':
    case 'pr-review-quality': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null
      return advanceLoopingRow(
        run, task, taskRow(task.phase), s.verdict.verdict === 'CLEAR',
        s.maxPasses, s.headSha,
      )
    }

    case 'ci': {
      if (s.ciBucket !== 'pass' && s.ciBucket !== 'fail') return null
      return advanceLoopingRow(
        run, task, taskRow('ci'), s.ciBucket === 'pass', s.maxPasses, s.headSha,
      )
    }

    case 'merge': {
      if (!s.merged) return null
      if (s.mergedAtMs === undefined || s.mergedAtMs <= task.phase_entered_at) return null
      task.merged_at_ms = s.mergedAtMs
      task.issue_closed_at_entry = s.issueClosed
      return enterTaskPhase(run, task, 'close', 'PR merged')
    }

    case 'close': {
      if (!s.issueClosed) return null
      // The edge is "closed by the merge that should have caused it", NOT "closed
      // after this phase began". GitHub auto-closes on merge, so closedAt always
      // predates phase entry and the v4 comparison was unsatisfiable.
      const closedByMerge =
        task.merged_at_ms !== null &&
        s.closedAtMs !== undefined &&
        s.closedAtMs >= task.merged_at_ms
      if (!task.issue_closed_at_entry && !closedByMerge) return null
      return enterTaskPhase(run, task, 'teardown', `issue #${task.issue} closed`)
    }

    case 'blocked-on-files': {
      if (!s.filesClear) return null
      return enterTaskPhase(run, task, 'implement', 'no overlapping files in flight')
    }

    default:
      return null
  }
}
