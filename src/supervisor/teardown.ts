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

export async function runTeardown(
  runs: Run[], removeWorktree: (workspaceId: string) => Promise<boolean>,
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

      const removed = await removeWorktree(task.workspace_id)
      enterTaskPhase(run, task, removed ? 'done' : 'orphaned',
        removed ? 'worktree removed' : 'worktree removal failed')
      completed.push(task)
    }
  }

  return completed
}
