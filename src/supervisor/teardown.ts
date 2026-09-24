import { existsSync } from 'node:fs'
import type { RunEffect } from '../lib/ledger'
import { enterTaskPhase } from '../lib/machine'
import { TASK_ROWS } from '../lib/phases'
import type { Run, Task, TaskPhase } from '../lib/types'

/**
 * "Has this task stopped moving", which is NOT the same question as `terminal`.
 * `escalated` is settled — nothing will move it on its own — but it is not
 * terminal, because it has a `returnsTo` and a human can rewind it. Derive this
 * from `terminal` alone and a run holding one escalated task never leaves
 * `execute`.
 */
export const SETTLED: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  ...TASK_ROWS.filter((r) => r.terminal).map((r) => r.phase),
  'escalated',
])

/** `gone`: herdr no longer knows the workspace, so there is nothing left for it to remove. */
export type WorktreeRemoval = 'removed' | 'gone' | 'failed'

/** herdr 0.9.0 answers `worktree remove` on an unknown workspace with this code. */
const WORKSPACE_NOT_FOUND = 'workspace_not_found'

export function worktreeRemovalFrom(result: { ok: boolean; code?: string }): WorktreeRemoval {
  if (result.ok) return 'removed'
  return result.code === WORKSPACE_NOT_FOUND ? 'gone' : 'failed'
}

export function markTornDown(run: Run, taskId: string, workspaceId: string): void {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (task?.phase !== 'teardown' || task.workspace_id !== workspaceId) return
  enterTaskPhase(run, task, 'done', 'worktree removed')
}

export async function runTeardown(
  runs: Run[], removeWorktree: (workspaceId: string) => Promise<WorktreeRemoval>,
  effects: RunEffect[] = [],
): Promise<Task[]> {
  const completed: Task[] = []

  for (const run of runs) {
    for (const task of run.tasks) {
      // Idempotent: teardown emits worktree.removed, which is one of our own hooks.
      if (task.phase !== 'teardown') continue

      if (task.keep_worktree || task.workspace_id === null) {
        enterTaskPhase(run, task, 'done', 'worktree kept by request')
        completed.push(task)
        continue
      }

      const workspaceId = task.workspace_id
      const removal = await removeWorktree(workspaceId)
      if (removal === 'removed') {
        markTornDown(run, task.task_id, workspaceId)
        effects.push((fresh) => markTornDown(fresh, task.task_id, workspaceId))
      } else if (removal === 'gone' && (task.checkout_path === null || !existsSync(task.checkout_path))) {
        // A second teardown of a worktree already removed — after a save that lost
        // to a CLI command, or a supervisor crash before its save. `orphaned` is
        // terminal-bad and would fail every dependent into `blocked-on-failure`.
        enterTaskPhase(run, task, 'done', 'worktree already removed')
      } else {
        enterTaskPhase(run, task, 'orphaned', removal === 'gone'
          ? `workspace gone but checkout left at ${task.checkout_path}`
          : 'worktree removal failed')
      }
      completed.push(task)
    }
  }

  return completed
}
