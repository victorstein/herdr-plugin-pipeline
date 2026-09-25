import { runRow, taskRow } from './phases'
import type { Run, Task } from './types'

/**
 * A worker's pane is recorded only when herdr detects an agent in its worktree
 * or `dispatch --task` hands it the brief, and the dispatch flow runs the repo's
 * bootstrap between `worktree create` and `agent start` — so a bound worktree
 * with no pane is normal for about that long.
 */
export const UNSTARTED_GRACE_MS = 5 * 60_000

export interface UnstartedWorker {
  workspaceId: string
  /** When the worktree was bound; the phase entry for a record whose stamp a rewind cleared. */
  since: number
}

/**
 * A worker row whose worktree exists but in which no agent has been detected.
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
 * The pane of a worker whose agent is running but has not been handed its
 * brief — the gap between `agent start` and `dispatch --task`, which is the
 * orchestrator's to close, not the worker's.
 */
export function unbriefedWorkerPane(run: Run, task: Task): string | null {
  if (runRow(run.phase).releasesPane === true) return null
  if (task.awaiting_brief !== true || task.phase !== taskRow('queued').onClear) return null
  return task.pane_id
}

/**
 * Records the worker's pane, and re-arms the stall ladder when that changes who
 * the task is waiting on. The ladder is keyed on the phase entry, which a bind
 * does not touch, so without the re-arm the orchestrator's probes about an empty
 * worktree count toward escalating a worker that has never been probed.
 */
export function bindWorkerPane(run: Run, task: Task, paneId: string, now: number): boolean {
  if (task.pane_id === paneId) return false
  task.pane_id = paneId
  // Any other row's ladder probes the orchestrator, whose silence a new worker
  // pane does not change.
  if (taskRow(task.phase).actor !== 'worker') return true
  task.stall = {
    at: task.phase_entered_at, run_at: run.phase_entered_at,
    last_probe_at: now, probes: 0, undelivered: 0, holds: 0,
  }
  return true
}

/**
 * Looks before it starts anything: hooks are at-most-once, so a lost
 * `pane.agent_detected` leaves a running agent's task looking exactly like this.
 * The pane is not named because the ledger never learns it: `worktree.created`
 * carries no root pane.
 */
export function startWorkerCommand(task: Task, workspaceId: string, hpipe: string): string {
  const look = `check \`herdr pane list --workspace ${workspaceId}\` first`
  const start = '`herdr agent start <name> --kind claude --pane <root pane>`'
  if (task.phase === taskRow('queued').onClear) {
    const dispatch = `\`${hpipe} dispatch --task ${task.task_id} --pane <pane>\``
    return `${look}. If an agent is already there, its detection was missed: ${dispatch} records ` +
      'it and hands it the brief, so `herdr pane read` it before, in case it already has one. ' +
      `If there is none, ${start}, then ${dispatch}`
  }
  // `dispatch --task` refuses every phase but the briefed one.
  return `${look}. If there is none, ${start}, then hand it \`${hpipe} brief --task ` +
    `${task.task_id}\` over \`herdr agent prompt\` and tell it the task is in ${task.phase}`
}
