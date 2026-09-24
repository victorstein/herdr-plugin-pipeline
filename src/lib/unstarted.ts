import { runRow, taskRow } from './phases'
import type { Run, Task } from './types'

/**
 * A worker's pane is recorded only when herdr detects an agent in its worktree,
 * and the dispatch flow runs the repo's bootstrap between `worktree create` and
 * `agent start` — so a bound worktree with no pane is normal for about that long.
 */
export const UNSTARTED_GRACE_MS = 5 * 60_000

export interface UnstartedWorker {
  workspaceId: string
  /** When the worktree was bound; the phase entry for a record whose stamp a rewind cleared. */
  since: number
}

/**
 * A worker row whose worktree exists but in which no agent was ever detected.
 * Nothing else notices one: with no pane the row's actor never reads idle, so
 * the phase cannot advance, and the digest called it "worker's move". The
 * berean-os run left `w23:p1` at a bare shell this way until the human spotted
 * it. Measured on a live run.
 */
export function unstartedWorker(run: Run, task: Task): UnstartedWorker | null {
  if (runRow(run.phase).releasesPane === true) return null
  if (taskRow(task.phase).actor !== 'worker') return null
  if (task.pane_id !== null || task.workspace_id === null) return null
  return { workspaceId: task.workspace_id, since: task.adopted_at ?? task.phase_entered_at }
}

export function overdueUnstartedWorker(run: Run, task: Task, now: number): UnstartedWorker | null {
  const unstarted = unstartedWorker(run, task)
  return unstarted !== null && now - unstarted.since >= UNSTARTED_GRACE_MS ? unstarted : null
}

/**
 * The pane is not named because the ledger never learns it: `worktree.created`
 * carries no root pane, and a pane is bound only once an agent is detected in it.
 */
export function startWorkerCommand(task: Task, workspaceId: string, hpipe: string): string {
  return `\`herdr agent start <name> --kind claude --pane <pane>\` in its root pane ` +
    `(\`herdr pane list --workspace ${workspaceId}\` names it), then ` +
    `\`${hpipe} dispatch --task ${task.task_id} --pane <pane>\``
}
