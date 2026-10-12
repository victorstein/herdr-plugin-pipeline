import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { forgetDispatchBases } from '../src/lib/dispatch-base'
import { newRun, withBatch } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { fetchBatches } from '../src/supervisor/batch-fetch'
import { advanceTasks } from '../src/supervisor/tasks'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'
import { cleanupFixtures, cloneOfRemote, commitAs, git, revParse, tempDir } from './helpers/git-worktree'

afterEach(() => {
  forgetDispatchBases()
  cleanupFixtures()
})

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core', depends_on: [], files: [], keep_worktree: false,
  workspace_id: null, pane_id: null, agent_status: 'idle', phase: 'merge', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} }, merged_at_ms: null, ...beadTaskFields(),
  passes: {}, decisions: [], decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', ...over,
})

/** origin with a batch branch and two task branches; the run's repo is a clone that fetched them once. */
function landingRepo(): { remote: string; clone: string; other: string; t1: string } {
  const { remote, clone } = cloneOfRemote('main')
  git(['push', '-q', 'origin', 'HEAD:refs/heads/batch/x'], clone)
  const other = join(tempDir('hpipe-other-'), 'other')
  git(['clone', '-q', remote, other], tempDir('hpipe-cwd-'))
  git(['checkout', '-q', '-b', 't1-branch', 'origin/batch/x'], other)
  commitAs(other, 'src/t1.ts', 't1\n')
  git(['push', '-q', 'origin', 't1-branch'], other)
  git(['checkout', '-q', '-b', 't3-branch', 'origin/batch/x'], other)
  commitAs(other, 'src/t3.ts', 't3\n')
  git(['push', '-q', 'origin', 't3-branch'], other)
  git(['fetch', '-q', 'origin'], clone)
  return { remote, clone, other, t1: revParse(other, 't1-branch') }
}

function runIn(clone: string, tasks: Task[]): Run {
  const run = withBatch(newRun({ session: 'p', socketPath: '/s', repoKey: clone, repoRoot: clone, title: 'a' }), batchFixture())
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  return run
}

const deps = (): Parameters<typeof advanceTasks>[1] => ({
  pluginRoot: join(import.meta.dir, '..'), liveIdle: async () => true, hasLiveAgent: () => true, maxPasses: 2,
  fileSettleMs: 0, prForBranch: async () => null, prView: async () => null, verdictFor: async () => null,
  removeWorktree: async () => 'removed', removeCheckout: async () => ({ removed: true }), ciDetail: async () => '',
  ambiguityLog: new Set<string>(), uncommittedPaths: async () => [],
  freshDispatchBase: async () => ({ commit: null, ref: 'origin/batch/x', fetchError: null }),
})

test('the batch branch is fetched alone, so a deleted sibling branch cannot hide a landing', async () => {
  const { clone, other, t1 } = landingRepo()
  const run = runIn(clone, [mkTask({ land_sha: t1, submission: {
    kind: 'implement', title: 'feat: t1', head_sha: t1, at: 0, check: 'none',
  } })])
  git(['push', '-q', 'origin', `${t1}:refs/heads/batch/x`], other)
  git(['push', '-q', 'origin', '--delete', 't3-branch'], other)

  await fetchBatches([run])
  expect(revParse(clone, 'refs/remotes/origin/batch/x')).toBe(t1)
  expect(run.batch?.fetch_error ?? null).toBeNull()
  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('close')
  expect(run.tasks[0]?.landed?.[0]?.land_sha).toBe(t1)
})

test('a failing batch fetch is recorded when it starts, and the next good one clears it', async () => {
  const { remote, clone, t1 } = landingRepo()
  const run = runIn(clone, [mkTask({ land_sha: t1 })])
  git(['remote', 'set-url', 'origin', join(tempDir('hpipe-gone-'), 'missing.git')], clone)
  await fetchBatches([run], undefined, 1_000)
  await fetchBatches([run], undefined, 2_000)
  expect(run.batch?.fetch_error).toMatchObject({ since: 1_000 })
  expect(run.batch?.fetch_error?.reason.length).toBeGreaterThan(0)

  git(['remote', 'set-url', 'origin', remote], clone)
  await fetchBatches([run], undefined, 3_000)
  expect(run.batch?.fetch_error ?? null).toBeNull()
})

test('nothing is fetched for a run with no task waiting to land, or for a per-task run', async () => {
  const fetched: string[] = []
  const fetch = async (root: string) => { fetched.push(root); return null }
  const quiet = runIn('/r1', [mkTask({ phase: 'implement' })])
  const perTask = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r2', title: 'a' })
  perTask.tasks = [mkTask({ phase: 'merge' })]
  const landing = runIn('/r3', [mkTask({ phase: 'land-queue' })])
  await fetchBatches([quiet, perTask, landing], fetch)
  expect(fetched).toEqual(['/r3'])
})
