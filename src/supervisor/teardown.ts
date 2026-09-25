import { existsSync } from 'node:fs'
import type { RunEffect } from '../lib/ledger'
import { enterTaskPhase } from '../lib/machine'
import { TASK_ROWS } from '../lib/phases'
import type { Run, Task, TaskPhase } from '../lib/types'

/**
 * "Will this task never move again", which is NOT "has it stopped moving".
 * `escalated` has stopped, but it is waiting on a human who resumes it with one
 * rewind, and its unmerged work is still on its branch. Counting it here once
 * let a run leave `execute` for the final review with a task abandoned
 * mid-`implement`, and announce the batch merged. Measured on a live run.
 */
export const FINISHED: ReadonlySet<TaskPhase> = new Set<TaskPhase>(
  TASK_ROWS.filter((r) => r.terminal).map((r) => r.phase),
)

/** `gone`: herdr no longer knows the workspace, so there is nothing left for it to remove. */
export type WorktreeRemoval = 'removed' | 'gone' | 'failed'

/** herdr 0.9.0 answers `worktree remove` on an unknown workspace with this code. */
const WORKSPACE_NOT_FOUND = 'workspace_not_found'

export function worktreeRemovalFrom(result: { ok: boolean; code?: string }): WorktreeRemoval {
  if (result.ok) return 'removed'
  return result.code === WORKSPACE_NOT_FOUND ? 'gone' : 'failed'
}

export interface TeardownDeps {
  removeWorktree: (workspaceId: string) => Promise<WorktreeRemoval>
  /** For a checkout whose workspace is gone: herdr 0.9.0's `worktree remove` takes only a workspace. */
  removeCheckout: (repoRoot: string, checkoutPath: string, branch: string) => Promise<boolean>
}

function markTornDown(run: Run, taskId: string, stillHolds: (task: Task) => boolean): void {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (task?.phase !== 'teardown' || !stillHolds(task)) return
  enterTaskPhase(run, task, 'done', 'worktree removed')
}

async function git(repoRoot: string, args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(['git', '-C', repoRoot, ...args], { stdout: 'ignore', stderr: 'ignore' })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

/**
 * `git worktree remove` refuses a path that is not one of the repo's worktrees,
 * so a wrong `checkout_path` cannot delete anything else. `branch -d` refuses a
 * branch whose commits are neither in HEAD nor in its upstream, so only work that
 * already lives elsewhere is dropped; its failure leaves the branch and is not a
 * failed teardown.
 */
export async function removeCheckoutWithGit(
  repoRoot: string, checkoutPath: string, branch: string,
): Promise<boolean> {
  if (!(await git(repoRoot, ['worktree', 'remove', '--force', checkoutPath]))) return false
  await git(repoRoot, ['branch', '-d', branch])
  return true
}

export async function runTeardown(
  runs: Run[], deps: TeardownDeps, effects: RunEffect[] = [],
): Promise<Task[]> {
  const completed: Task[] = []

  for (const run of runs) {
    for (const task of run.tasks) {
      // Idempotent: teardown emits worktree.removed, which is one of our own hooks.
      if (task.phase !== 'teardown') continue
      completed.push(task)

      if (task.keep_worktree) {
        enterTaskPhase(run, task, 'done', 'worktree kept by request')
        continue
      }

      const workspaceId = task.workspace_id
      if (workspaceId !== null) {
        const removal = await deps.removeWorktree(workspaceId)
        if (removal === 'removed') {
          const holdsWorkspace = (t: Task) => t.workspace_id === workspaceId
          markTornDown(run, task.task_id, holdsWorkspace)
          effects.push((fresh) => markTornDown(fresh, task.task_id, holdsWorkspace))
          continue
        }
        if (removal === 'failed') {
          enterTaskPhase(run, task, 'orphaned', 'worktree removal failed')
          continue
        }
      }

      const checkoutPath = task.checkout_path
      if (checkoutPath === null || !existsSync(checkoutPath)) {
        // A second teardown of a worktree already removed — after a save that lost
        // to a CLI command, or a supervisor crash before its save. `orphaned` is
        // terminal-bad and would fail every dependent into `blocked-on-failure`.
        enterTaskPhase(run, task, 'done', checkoutPath === null && workspaceId === null
          ? 'no worktree was recorded'
          : 'worktree already removed')
        continue
      }

      // A workspace closed under a task in `merge` or `close` leaves its checkout
      // behind; ending there `orphaned` called a merged task a dead end and left
      // the worktree on disk. Measured on a live run.
      if (await deps.removeCheckout(run.repo_root, checkoutPath, task.branch)) {
        const holdsCheckout = (t: Task) => t.checkout_path === checkoutPath
        markTornDown(run, task.task_id, holdsCheckout)
        effects.push((fresh) => markTornDown(fresh, task.task_id, holdsCheckout))
      } else {
        enterTaskPhase(run, task, 'orphaned', `workspace gone and removing the checkout at ${checkoutPath} failed`)
      }
    }
  }

  return completed
}
