import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  FINISHED, removeCheckoutWithGit, runTeardown, type TeardownDeps, type WorktreeRemoval, worktreeRemovalFrom,
} from '../src/supervisor/teardown'
import { applyEvents } from '../src/supervisor/tick'
import { newRun, type RunEffect } from '../src/lib/ledger'
import { enterTaskPhase } from '../src/lib/machine'
import type { Run, Task } from '../src/lib/types'
import { cleanupFixtures, commitIn, git, repoWithWorktree, revParse, tempDir } from './helpers/git-worktree'

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
    async (repoRoot, path, branch) => {
      removedCheckouts.push(`${repoRoot} ${path} ${branch}`)
      return { removed: true as const }
    },
  ), effects)
  expect(removedCheckouts).toEqual([`/r ${checkout} feat/x`])
  expect(run.tasks[0]?.phase).toBe('done')
  expect(effects).toHaveLength(1)
})

test('a checkout kept by the path removal still ends done, naming why — #116', async () => {
  const checkout = tempDir('teardown-checkout-')
  const run = mkRun([mkTask({ workspace_id: null, checkout_path: checkout })])
  await runTeardown([run], removingBy(
    async () => 'gone' as const,
    async () => ({ removed: false as const, kept: 'detached HEAD, not on feat/x' }),
  ))
  expect(run.tasks[0]?.phase).toBe('done')
  expect(run.history.at(-1)?.why).toBe(`worktree kept: ${checkout} (detached HEAD, not on feat/x)`)
})

/** What the worker's `git push -u origin HEAD` leaves behind, without a remote. */
const pushed = (worktree: string): void => git(['update-ref', 'refs/remotes/origin/feat/x', 'HEAD'], worktree)

const kept = (why: string) => ({ removed: false, kept: why })

test('a clean pushed checkout is removed by path, with its merged branch — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  pushed(worktree)
  const repoRoot = repoRootOf(worktree)
  expect(await removeCheckoutWithGit(repoRoot, worktree, 'feat/x', null)).toEqual({ removed: true })
  expect(existsSync(worktree)).toBe(false)
  expect(branchExists(repoRoot, 'feat/x')).toBe(false)
})

test('gitignored extras do not keep a checkout — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  commitIn(worktree, '.gitignore', 'node_modules/\n')
  pushed(worktree)
  mkdirSync(join(worktree, 'node_modules'))
  writeFileSync(join(worktree, 'node_modules', 'dep.js'), 'x\n')
  expect(await removeCheckoutWithGit(repoRootOf(worktree), worktree, 'feat/x', null)).toEqual({ removed: true })
  expect(existsSync(worktree)).toBe(false)
})

test('a pushed branch that main has not merged is kept after the checkout goes — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  commitIn(worktree, 'src/squashed.ts', 'landed as a squash\n')
  pushed(worktree)
  const repoRoot = repoRootOf(worktree)
  expect(await removeCheckoutWithGit(repoRoot, worktree, 'feat/x', null)).toEqual({ removed: true })
  expect(branchExists(repoRoot, 'feat/x')).toBe(true)
})

test('an untracked file keeps the checkout and survives — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  pushed(worktree)
  writeFileSync(join(worktree, 'notes.md'), 'a human was here\n')
  expect(await removeCheckoutWithGit(repoRootOf(worktree), worktree, 'feat/x', null))
    .toEqual(kept('modified or untracked files'))
  expect(readFileSync(join(worktree, 'notes.md'), 'utf8')).toBe('a human was here\n')
})

test('a commit on a detached HEAD keeps the checkout and survives — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  pushed(worktree)
  git(['checkout', '-q', '--detach'], worktree)
  commitIn(worktree, 'src/detached.ts', 'on no branch\n')
  const detached = revParse(worktree, 'HEAD')
  const repoRoot = repoRootOf(worktree)
  expect(await removeCheckoutWithGit(repoRoot, worktree, 'feat/x', null)).toEqual(kept('detached HEAD, not on feat/x'))
  expect(existsSync(worktree)).toBe(true)
  expect(revParse(worktree, 'HEAD')).toBe(detached)
})

test('a checkout switched to another branch is kept — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  pushed(worktree)
  git(['checkout', '-q', '-b', 'human/next'], worktree)
  expect(await removeCheckoutWithGit(repoRootOf(worktree), worktree, 'feat/x', null))
    .toEqual(kept('on human/next, not feat/x'))
  expect(existsSync(worktree)).toBe(true)
})

test('a commit made after the push keeps the checkout — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  pushed(worktree)
  commitIn(worktree, 'src/after-merge.ts', 'local only\n')
  expect(await removeCheckoutWithGit(repoRootOf(worktree), worktree, 'feat/x', null))
    .toEqual(kept('HEAD not pushed to origin/feat/x'))
  expect(existsSync(worktree)).toBe(true)
})

/** GitHub keeps `refs/pull/<n>/head` after auto-deleting the merged branch; a pruning fetch then drops the tracking ref. */
function mergedWithBranchDeleted(worktree: string, pr: number): void {
  const remote = tempDir('teardown-remote-')
  git(['init', '-q', '--bare', '.'], remote)
  git(['remote', 'add', 'origin', remote], worktree)
  git(['push', '-q', 'origin', 'HEAD:refs/heads/feat/x', `HEAD:refs/pull/${pr}/head`], worktree)
  git(['push', '-q', 'origin', '--delete', 'feat/x'], worktree)
  git(['fetch', '-q', '--prune', 'origin'], worktree)
}

test('a merged branch deleted from origin is proven pushed by its PR head — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  commitIn(worktree, 'src/work.ts', 'merged\n')
  mergedWithBranchDeleted(worktree, 7)
  expect(Bun.spawnSync(['git', '-C', worktree, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feat/x']).success)
    .toBe(false)
  expect(await removeCheckoutWithGit(repoRootOf(worktree), worktree, 'feat/x', 7)).toEqual({ removed: true })
  expect(existsSync(worktree)).toBe(false)
})

test('with no PR to check, a branch deleted from origin keeps the checkout — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  mergedWithBranchDeleted(worktree, 7)
  expect(await removeCheckoutWithGit(repoRootOf(worktree), worktree, 'feat/x', null))
    .toEqual(kept('HEAD not pushed to origin/feat/x'))
})

test('a commit beyond the PR head keeps the checkout — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  mergedWithBranchDeleted(worktree, 7)
  commitIn(worktree, 'src/after-merge.ts', 'local only\n')
  expect(await removeCheckoutWithGit(repoRootOf(worktree), worktree, 'feat/x', 7))
    .toEqual(kept('HEAD on neither origin/feat/x nor PR #7\'s head'))
  expect(existsSync(worktree)).toBe(true)
})

test('a locked worktree is kept under a short label, not git\'s force advice — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  pushed(worktree)
  git(['worktree', 'lock', worktree], worktree)
  expect(await removeCheckoutWithGit(repoRootOf(worktree), worktree, 'feat/x', null)).toEqual(kept('locked'))
  expect(existsSync(worktree)).toBe(true)
})

test('a path that is not a worktree of the repo is refused, never deleted — #116', async () => {
  const worktree = repoWithWorktree(['README.md'])
  const stranger = tempDir('teardown-stranger-')
  expect(await removeCheckoutWithGit(repoRootOf(worktree), stranger, 'feat/x', null))
    .toEqual(kept('not a linked worktree of this repo'))
  expect(existsSync(stranger)).toBe(true)
})

test('a task whose workspace closed in merge reaches done with its worktree removed — #116', async () => {
  // The live t4: `workspace close` in `merge`, then the PR merged and teardown ran.
  const worktree = repoWithWorktree(['README.md'])
  pushed(worktree)
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
