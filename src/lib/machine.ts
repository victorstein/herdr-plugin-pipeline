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
  // Only the gate opening puts a task in front of a worker that has not been
  // told about it yet; every later transition follows the worker's own work.
  if (task.phase === 'queued' && phase === taskRow('queued').onClear) task.awaiting_brief = true
  else delete task.awaiting_brief
  if (phase === 'blocked-on-decision') {
    task.artifact_fresh_after ??= task.phase_entered_at
    delete task.answer_sent_at
    delete task.worked_on_answer
  } else if (!leavesDecisionPending(task, phase)) {
    forgetDecisionRoundTrip(task)
  }
  task.phase = phase
  task.phase_entered_at = Date.now()
  return task
}

/**
 * Resuming the asked-from phase, or escalating out of the decision — which a
 * rewind back into `blocked-on-decision` resumes — keeps the round trip's record.
 */
function leavesDecisionPending(task: Task, phase: TaskPhase): boolean {
  return task.phase === 'blocked-on-decision' && (phase === task.decision_from || phase === 'escalated')
}

export function forgetDecisionRoundTrip(task: Task): void {
  delete task.artifact_fresh_after
  delete task.answer_sent_at
  delete task.worked_on_answer
}

/**
 * What the current phase's artifact or verdict must be newer than. A worker that
 * writes its verdict and then asks a decision resumes into a re-stamped phase, and
 * judged against that entry its verdict read as stale and the task sat idle until a
 * stall probe. Measured on a live run. The earlier entry counts only once the
 * worker has been seen working after its answer went in: the verdict is read on
 * the next idle, so one the answer changes has been rewritten by then, and an
 * idle read before that turn cannot clear the phase on a verdict the answer might
 * overturn.
 */
export function artifactFreshAfter(task: Task): number {
  return task.artifact_fresh_after !== undefined && task.worked_on_answer === true
    ? task.artifact_fresh_after
    : task.phase_entered_at
}

/** A working report after the answer was sent; before it, working is about something else. */
export function noteWorkingAfterAnswer(task: Task, at: number): void {
  if (task.answer_sent_at !== undefined && at >= task.answer_sent_at) task.worked_on_answer = true
}

export interface TaskSignals {
  actorIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  prNumber: number | null
  headSha: string | null
  merged: boolean
  mergedAtMs?: number
  mergeCommit?: string
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
      // A level for the same reason as the run's `dispatch` row: a PR merged
      // before the task entered `merge` (merging is the human's move and races
      // the CI poll), or a rewind into `merge` after it, stranded the task here.
      if (!s.merged || s.mergedAtMs === undefined) return null
      task.merged_at_ms = s.mergedAtMs
      task.merge_commit = s.mergeCommit ?? null
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
