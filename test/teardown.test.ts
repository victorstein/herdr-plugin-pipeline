import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  FINISHED, removeCheckoutWithGit, runTeardown, type TeardownDeps, type WorktreeRemoval, worktreeRemovalFrom,
} from '../src/supervisor/teardown'
import { applyEvents } from '../src/supervisor/tick'
import { newRun, type RunEffect } from '../src/lib/ledger'
import { enterTaskPhase } from '../src/lib/machine'
import type { Run, Task } from '../src/lib/types'
import { cleanupFixtures, commitIn, repoWithWorktree, tempDir } from './helpers/git-worktree'

afterEach(cleanupFixtures)

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'teardown', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: 5, ci: 'pass',
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function mkRun(tasks: Task[], repoRoot = '/r'): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot, title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

const removingBy = (
  removeWorktree: (ws: string) => Promise<WorktreeRemoval>,
  removeCheckout: TeardownDeps['removeCheckout'] = async () => { throw new Error('no checkout removal expected') },
): TeardownDeps => ({ removeWorktree, removeCheckout })

const repoRootOf = (worktree: string): string =>
  dirname(Bun.spawnSync(['git', '-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { stdout: 'pipe' }).stdout.toString().trim())

const branchExists = (repoRoot: string, branch: string): boolean =>
  Bun.spawnSync(['git', '-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).success

test('removes the worktree and marks the task done', async () => {
  const run = mkRun([mkTask({})])
  const removed: string[] = []
  await runTeardown([run], removingBy(async (ws) => { removed.push(ws); return 'removed' as const }))
  expect(removed).toEqual(['w7'])
  expect(run.tasks[0]?.phase).toBe('done')
})

test('keep_worktree skips removal but still completes the task', async () => {
  const run = mkRun([mkTask({ keep_worktree: true })])
  const removed: string[] = []
  await runTeardown([run], removingBy(async (ws) => { removed.push(ws); return 'removed' as const }))
  expect(removed).toEqual([])
  expect(run.tasks[0]?.phase).toBe('done')
})

test('a failed removal marks the task orphaned rather than done', async () => {
  const run = mkRun([mkTask({})])
  await runTeardown([run], removingBy(async () => 'failed' as const))
  expect(run.tasks[0]?.phase).toBe('orphaned')
})

test('is idempotent — an already-done task is not torn down twice', async () => {
  const run = mkRun([mkTask({ phase: 'done' })])
  let calls = 0
  await runTeardown([run], removingBy(async () => { calls++; return 'removed' as const }))
  expect(calls).toBe(0)
})

test('herdr 0.9.0\'s unknown-workspace answer reads as gone, anything else as failed', () => {
  // Probed live: `herdr worktree remove --workspace <bogus> --force` exits 1 with
  // {"error":{"code":"workspace_not_found",...}}.
  expect(worktreeRemovalFrom({ ok: true })).toBe('removed')
  expect(worktreeRemovalFrom({ ok: false, code: 'workspace_not_found' })).toBe('gone')
  expect(worktreeRemovalFrom({ ok: false, code: 'unparseable' })).toBe('failed')
})

test('a removal already done records nothing to re-apply, a fresh one does', async () => {
  const effects: RunEffect[] = []
  const run = mkRun([mkTask({ task_id: 't1' }), mkTask({ task_id: 't2', workspace_id: 'w8', checkout_path: null })])
  await runTeardown([run], removingBy(async (ws) => (ws === 'w7' ? 'removed' : 'gone')), effects)
  expect(run.tasks.map((t) => t.phase)).toEqual(['done', 'done'])
  expect(effects).toHaveLength(1)
})

test('a task with no workspace and no checkout on disk completes without removing anything — #116', async () => {
  const run = mkRun([
    mkTask({ task_id: 't1', workspace_id: null, checkout_path: null }),
    mkTask({ task_id: 't2', workspace_id: null, checkout_path: '/nonexistent/wt' }),
  ])
  await runTeardown([run], removingBy(async () => { throw new Error('no workspace to remove') }))
  expect(run.tasks.map((t) => t.phase)).toEqual(['done', 'done'])
})

test('a gone workspace falls back to removing the checkout by its path — #116', async () => {
  const checkout = tempDir('teardown-checkout-')
  const effects: RunEffect[] = []
  const run = mkRun([mkTask({ checkout_path: checkout })])
  const removedCheckouts: string[] = []
  await runTeardown([run], removingBy(
    async () => 'gone' as const,
    async (repoRoot, path, branch) => { removedCheckouts.push(`${repoRoot} ${path} ${branch}`); return true },
  ), effects)
  expect(removedCheckouts).toEqual([`/r ${checkout} feat/x`])
  expect(run.tasks[0]?.phase).toBe('done')
  expect(effects).toHaveLength(1)
})

test('a checkout that cannot be removed by its path is orphaned — #116', async () => {
  const checkout = tempDir('teardown-checkout-')
  const run = mkRun([mkTask({ workspace_id: null, checkout_path: checkout })])
  await runTeardown([run], removingBy(async () => 'gone' as const, async () => false))
  expect(run.tasks[0]?.phase).toBe('orphaned')
})

test('removing a checkout by path removes the worktree and a merged branch — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  const repoRoot = repoRootOf(worktree)
  expect(await removeCheckoutWithGit(repoRoot, worktree, 'feat/x')).toBe(true)
  expect(existsSync(worktree)).toBe(false)
  expect(branchExists(repoRoot, 'feat/x')).toBe(false)
})

test('removing a checkout by path keeps a branch whose commits are nowhere else — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  commitIn(worktree, 'src/only-here.ts', 'unmerged\n')
  const repoRoot = repoRootOf(worktree)
  expect(await removeCheckoutWithGit(repoRoot, worktree, 'feat/x')).toBe(true)
  expect(existsSync(worktree)).toBe(false)
  expect(branchExists(repoRoot, 'feat/x')).toBe(true)
})

test('a path that is not a worktree of the repo is refused, never deleted — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  const stranger = tempDir('teardown-stranger-')
  expect(await removeCheckoutWithGit(repoRootOf(worktree), stranger, 'feat/x')).toBe(false)
  expect(existsSync(stranger)).toBe(true)
})

test('a task whose workspace closed in merge reaches done with its worktree removed — #116', async () => {
  // The live t4: `workspace close` in `merge`, then the PR merged and teardown ran.
  const worktree = repoWithWorktree(['README.md'])
  const repoRoot = repoRootOf(worktree)
  const run = mkRun([mkTask({ phase: 'merge', workspace_id: 'w5', pane_id: null, checkout_path: worktree })], repoRoot)
  applyEvents([run], [{ kind: 'workspace.closed', session: 'p', at: 1, workspace_id: 'w5' }], 'p', new Set())
  expect(run.tasks[0]?.workspace_id).toBeNull()

  enterTaskPhase(run, run.tasks[0]!, 'teardown', 'issue closed')
  await runTeardown([run], removingBy(
    async () => { throw new Error('herdr cannot remove a workspace that is gone') },
    removeCheckoutWithGit,
  ))
  expect(run.tasks[0]?.phase).toBe('done')
  expect(existsSync(worktree)).toBe(false)
})

test('FINISHED excludes escalated, which has stopped but a rewind resumes', () => {
  expect(FINISHED.has('escalated')).toBe(false)
  expect(FINISHED.has('done')).toBe(true)
  expect(FINISHED.has('implement')).toBe(false)
})
