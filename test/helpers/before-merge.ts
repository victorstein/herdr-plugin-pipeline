import { newRun, withBatch } from '../../src/lib/ledger'
import type { BeforeMergeCheck, Resolution, Run, Task, TaskPhase } from '../../src/lib/types'
import { batchFixture } from './batch'
import { beadTaskFields } from './bead-fields'

export const CHECKED_HEAD = '9e06c261' + '0'.repeat(32)
export const NEWER_HEAD = '5e6f7a8b' + '0'.repeat(32)

export function heldTask(over: Partial<Task> = {}): Task {
  return {
    task_id: 't1', branch: 'feat/ghost', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
    keep_worktree: false, workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase: 'merge' as TaskPhase, phase_entered_at: 1_000, escalated_from: null, head_sha_at_entry: null,
    pr: 255, ci: 'pass', ci_head: { sha: CHECKED_HEAD, seen_at: 1 },
    checkout_path: '/r/.worktrees/feat-ghost', registered_at: 1, adopted_at: 1,
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    ...over,
  }
}

export function checkOf(id: string, resolutions: Resolution[] = [], over: Partial<BeforeMergeCheck> = {}): BeforeMergeCheck {
  return {
    id, check: 'the reader shows no ghost after a page turn', recorded_at: 1, recorded_pane: 'w1:p1',
    resolutions, ...over,
  }
}

export const ruling = (as: Resolution['as'], head: string | null, note?: string): Resolution =>
  ({ as, at: 2, head, pane: 'w1:p1', ...(note === undefined ? {} : { note }) })

export function perTaskRun(tasks: Task[]): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  return run
}

export function singlePrRun(tasks: Task[], phase: Run['phase'] = 'ship-merge'): Run {
  const run = withBatch(
    newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' }),
    batchFixture({ pr: 301, ci: 'pass', ci_head: { sha: CHECKED_HEAD, seen_at: 1 } }),
  )
  run.phase = phase
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  return run
}
