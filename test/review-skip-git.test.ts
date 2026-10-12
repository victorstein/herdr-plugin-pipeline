import { afterEach, expect, test } from 'bun:test'
import { newRun, withBatch } from '../src/lib/ledger'
import { ALWAYS_REVIEW_REL, changeSize } from '../src/lib/review-skip'
import { fileAt, numstat } from '../src/lib/sync-walk'
import type { Run, Task } from '../src/lib/types'
import { advanceTasks, type TaskDeps } from '../src/supervisor/tasks'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'
import { cleanupFixtures, cloneOfRemote, commitAs, git, landOnRemote, revParse } from './helpers/git-worktree'

/**
 * The skip's git reads against a real bare origin: the fetch refspecs, the
 * three-dot numstat and the always-review file at the base, through the tick's
 * own defaults. Only gh is faked.
 */

afterEach(cleanupFixtures)

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'

/** A branch off origin's `base` with a small code change and a large doc, pushed. Returns its head. */
function pushedChange(clone: string, base: string, branch: string): string {
  git(['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], clone)
  git(['checkout', '-q', '-b', branch, `origin/${base}`], clone)
  commitAs(clone, 'src/menu.ts', lines(3))
  commitAs(clone, 'docs/menu.md', lines(400))
  git(['push', '-q', 'origin', branch], clone)
  return revParse(clone, 'HEAD')
}

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'implement', phase_entered_at: 10, escalated_from: null,
  head_sha_at_entry: null, pr: 42, ci: null,
  checkout_path: null, registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', tier: 'light',
  ...over,
})

function runIn(repoRoot: string, task: Task, singlePr: boolean): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot, title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [task]
  run.history = [{ at: 1, task_id: 't1', from: 'spec-review', to: 'plan', why: 'cleared' }]
  return singlePr ? withBatch(run, batchFixture({ branch: 'batch/x' })) : run
}

const deps = (headSha: string | null = null): TaskDeps => ({
  pluginRoot: process.cwd(),
  liveIdle: async () => true,
  hasLiveAgent: () => true,
  maxPasses: 2,
  fileSettleMs: 0,
  prForBranch: async () => 42,
  prView: async () => ({ merged: false, mergedAtMs: null, headSha, baseRef: 'main' }),
  verdictFor: async () => null,
  removeWorktree: async () => 'removed',
  removeCheckout: async () => ({ removed: true }),
  ciDetail: async () => '',
  ambiguityLog: new Set<string>(),
  uncommittedPaths: async () => [],
  freshDispatchBase: async () => ({ commit: null, ref: 'origin/main', fetchError: null }),
})

test('numstat sizes a change from its merge base, so what landed on the base since is not counted', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const head = pushedChange(clone, 'main', 't1-branch')
  landOnRemote(remote, 'main', 'src/elsewhere.ts')
  git(['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], clone)

  const counted = await numstat(clone, 'refs/remotes/origin/main', head)
  expect(changeSize(counted ?? 'unread')).toEqual({ added: 3, paths: ['docs/menu.md', 'src/menu.ts'] })
  expect(await numstat(clone, 'refs/remotes/origin/main', 'f'.repeat(40))).toBeNull()
})

test('fileAt reads a file at a ref, says when the ref has none, and fails on a ref that is not there', async () => {
  const { remote, clone } = cloneOfRemote('main')
  expect(await fileAt(clone, 'refs/remotes/origin/main', ALWAYS_REVIEW_REL)).toEqual({ ok: true, text: null })
  landOnRemote(remote, 'main', ALWAYS_REVIEW_REL)
  git(['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], clone)
  expect(await fileAt(clone, 'refs/remotes/origin/main', ALWAYS_REVIEW_REL)).toEqual({ ok: true, text: 'sibling-owned' })
  expect(await fileAt(clone, 'refs/remotes/origin/gone', ALWAYS_REVIEW_REL)).toEqual({ ok: false })
})

test('a per-task light change goes past its PR review to ci, sized against the PR base as fetched', async () => {
  const { clone } = cloneOfRemote('main')
  const head = pushedChange(clone, 'main', 't1-branch')
  const task = mkTask({ head_sha_at_entry: 'old' })
  await advanceTasks(runIn(clone, task, false), deps(head))
  expect(task.phase).toBe('ci')
  expect(task.review_skip).toMatchObject({ added_lines: 3, cleared: ['spec-review'] })
})

test('a change touching the always-review list on its base is reviewed however small', async () => {
  const { clone } = cloneOfRemote('main')
  commitAs(clone, ALWAYS_REVIEW_REL, '# code a reviewer must see\nsrc/menu.ts\n')
  git(['push', '-q', 'origin', 'HEAD:main'], clone)
  const head = pushedChange(clone, 'main', 't1-branch')

  const task = mkTask({ head_sha_at_entry: 'old' })
  await advanceTasks(runIn(clone, task, false), deps(head))
  expect(task.phase).toBe('pr-review')
  expect(task.review_skip).toBeUndefined()
})

test('a single-PR light change goes past its PR review into land-queue, landing the head it measured', async () => {
  const { remote, clone } = cloneOfRemote('main')
  git(['push', '-q', remote, 'HEAD:refs/heads/batch/x'], clone)
  const head = pushedChange(clone, 'batch/x', 't1-branch')
  const task = mkTask({
    pr: null, submission: { kind: 'implement', title: 'fix(menu): close', head_sha: head, at: 20, check: 'passed' },
  })
  await advanceTasks(runIn(clone, task, true), deps())
  expect(task.phase).toBe('land-queue')
  expect(task.land_sha).toBe(head)
  expect(task.review_skip).toMatchObject({ added_lines: 3 })
})
