import { enterRunPhase, enterTaskPhase } from '../lib/machine'
import type { Run, Task, TaskPhase } from '../lib/types'

const SETTLED: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'done', 'failed', 'orphaned', 'blocked-on-failure', 'escalated',
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

    if (run.phase === 'execute' && run.tasks.length > 0 && run.tasks.every((t) => SETTLED.has(t.phase))) {
      enterRunPhase(run, 'branch-review', 'all tasks settled')
    }
  }

  return completed
}
