import { existsSync, realpathSync } from 'node:fs'
import { fetchRemoteBranch } from '../lib/dispatch-base'
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

/** `kept` says why the checkout was left on disk. */
export type CheckoutRemoval = { removed: true } | { removed: false; kept: string }

export interface TeardownDeps {
  removeWorktree: (workspaceId: string) => Promise<WorktreeRemoval>
  /** For a checkout whose workspace is gone: herdr 0.9.0's `worktree remove` takes only a workspace. */
  removeCheckout: (repoRoot: string, checkoutPath: string, branch: string) => Promise<CheckoutRemoval>
}

function markTornDown(run: Run, taskId: string, stillHolds: (task: Task) => boolean): void {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (task?.phase !== 'teardown' || !stillHolds(task)) return
  enterTaskPhase(run, task, 'done', 'worktree removed')
}

async function git(repoRoot: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const proc = Bun.spawn(['git', '-C', repoRoot, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { ok: (await proc.exited) === 0, out, err }
  } catch {
    return { ok: false, out: '', err: 'git could not be run' }
  }
}

function samePath(a: string, b: string): boolean {
  const real = (path: string) => {
    try { return realpathSync(path) } catch { return path }
  }
  return real(a) === real(b)
}

interface LinkedWorktree { head: string | null; branch: string | null }

/** The first porcelain entry is the main worktree, which is never ours to remove. */
async function linkedWorktreeAt(repoRoot: string, checkoutPath: string): Promise<LinkedWorktree | null> {
  const listed = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  if (!listed.ok) return null
  for (const entry of listed.out.split(/\n\n+/).slice(1)) {
    const field = (name: string) =>
      entry.split('\n').find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? null
    const path = field('worktree')
    if (path !== null && samePath(path, checkoutPath)) return { head: field('HEAD'), branch: field('branch') }
  }
  return null
}

/**
 * Only for a checkout that has left herdr's hands: its workspace was closed, or
 * `forget` unbound it, and a human may still be working in it. So nothing is
 * forced. Any doubt keeps the checkout, and the task still ends `done`, because
 * its PR has merged:
 * - It must be a linked worktree of this repo still on the task's branch. A
 *   detached or switched checkout may hold commits on no branch at all.
 * - Its HEAD must be on `origin/<branch>`. Otherwise it has local commits that
 *   `branch -d` would keep on the branch but nothing would ever report.
 * - Without `--force`, `worktree remove` refuses modified or untracked files and
 *   still removes a tree whose only extras are gitignored.
 *
 * `branch -d` then drops the local branch only if it is merged into the main
 * checkout's HEAD or into its upstream; a refusal leaves the branch in place.
 */
export async function removeCheckoutWithGit(
  repoRoot: string, checkoutPath: string, branch: string,
): Promise<CheckoutRemoval> {
  const keep = (why: string): CheckoutRemoval => ({ removed: false, kept: why })

  const worktree = await linkedWorktreeAt(repoRoot, checkoutPath)
  if (worktree === null) return keep('not a linked worktree of this repo')
  if (worktree.branch === null) return keep(`detached HEAD, not on ${branch}`)
  if (worktree.branch !== `refs/heads/${branch}`) {
    return keep(`on ${worktree.branch.replace(/^refs\/heads\//, '')}, not ${branch}`)
  }

  await fetchRemoteBranch(repoRoot, branch)
  const pushed = worktree.head !== null &&
    (await git(repoRoot, ['merge-base', '--is-ancestor', worktree.head, `refs/remotes/origin/${branch}`])).ok
  if (!pushed) return keep(`HEAD not pushed to origin/${branch}`)

  const removal = await git(repoRoot, ['worktree', 'remove', checkoutPath])
  if (!removal.ok) {
    return keep(/modified or untracked/.test(removal.err)
      ? 'modified or untracked files'
      : removal.err.trim().split('\n').pop() || 'git worktree remove failed')
  }
  await git(repoRoot, ['branch', '-d', branch])
  return { removed: true }
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
      const removal = await deps.removeCheckout(run.repo_root, checkoutPath, task.branch)
      if (removal.removed) {
        const holdsCheckout = (t: Task) => t.checkout_path === checkoutPath
        markTornDown(run, task.task_id, holdsCheckout)
        effects.push((fresh) => markTornDown(fresh, task.task_id, holdsCheckout))
      } else {
        enterTaskPhase(run, task, 'done', `worktree kept: ${checkoutPath} (${removal.kept})`)
      }
    }
  }

  return completed
}
