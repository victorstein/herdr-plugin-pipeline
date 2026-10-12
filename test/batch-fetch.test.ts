import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
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

test('the clean-up deletes only task branches whose head landed, and names the rest', async () => {
  const { cleanupLines } = await import('../src/supervisor/deliver')
  const { clone, other, t1 } = landingRepo()
  git(['push', '-q', 'origin', `${t1}:refs/heads/batch/x`], other)
  git(['checkout', '-q', 't1-branch'], other)
  commitAs(other, 'src/handoff.ts', 'pushed after the landing\n')
  git(['push', '-q', 'origin', 't1-branch'], other)
  git(['push', '-q', 'origin', '--delete', 't3-branch'], other)
  git(['fetch', '-q', 'origin', '+refs/heads/batch/x:refs/remotes/origin/batch/x'], clone)
  const handoff = revParse(other, 't1-branch')

  const landedOnly = runIn(clone, [mkTask({ task_id: 't1', branch: 't1-branch' }), mkTask({ task_id: 't3', branch: 't3-branch' })])
  const unread = await cleanupLines(landedOnly, landedOnly.batch!)
  expect(unread.join('\n')).not.toContain('--delete t1-branch')
  expect(unread).toContain(`  t1-branch is at ${handoff.slice(0, 8)}, which could not be compared with batch/x here; ` +
    'fetch it and check before deleting')

  git(['fetch', '-q', 'origin', '+refs/heads/t1-branch:refs/remotes/origin/t1-branch'], clone)
  const lines = await cleanupLines(landedOnly, landedOnly.batch!)
  expect(lines.join('\n')).not.toContain('--delete t1-branch')
  expect(lines).toContain(`  t1-branch has commits that did not land: ${handoff.slice(0, 8)}; review before deleting`)
  expect(lines.join('\n')).not.toContain('t3-branch')
  expect(lines.at(-1)).toBe(`  git -C '${clone}' branch -D batch/x`)

  git(['push', '-q', '--force', 'origin', `${t1}:refs/heads/t1-branch`], other)
  expect((await cleanupLines(landedOnly, landedOnly.batch!)).join('\n'))
    .toContain(`git -C '${clone}' push origin --delete t1-branch`)
})

test('a shipped run names what its clean-up leaves: local task branches, the batch on origin, a stale default branch, the review', async () => {
  const { renderRunPhasePrompt } = await import('../src/supervisor/deliver')
  const { clone, other, t1 } = landingRepo()
  git(['push', '-q', 'origin', `${t1}:refs/heads/batch/x`], other)
  git(['fetch', '-q', 'origin'], clone)
  git(['branch', 't1-branch', 'origin/t1-branch'], clone)
  git(['branch', 't3-branch', 'origin/t3-branch'], clone)
  const t3 = revParse(clone, 't3-branch')
  const review = 'docs/superpowers/reviews/r1-branch-review-0.md'
  mkdirSync(join(clone, 'docs', 'superpowers', 'reviews'), { recursive: true })
  writeFileSync(join(clone, review), 'VERDICT: CLEAR\n')

  const run = runIn(clone, [
    mkTask({ task_id: 't1', branch: 't1-branch', phase: 'done' }), mkTask({ task_id: 't3', branch: 't3-branch', phase: 'done' }),
  ])
  run.phase = 'done'
  run.batch = { ...run.batch!, pr: 51, merged_at_ms: 1, merge_commit: 'f00dfeed00000000000000000000000000000000' }
  run.artifacts.verdicts = { 'branch-review-0': review }
  const ROOT = join(import.meta.dir, '..')

  const text = await renderRunPhasePrompt(run, ROOT)
  expect(text).toContain(`  git -C '${clone}' branch -D t1-branch\n`)
  expect(text).toContain(`  local t3-branch has commits that did not land: ${t3.slice(0, 8)}; review before deleting`)
  expect(text).toContain(`  git -C '${clone}' pull --ff-only  # main predates PR #51's squash merge`)
  expect(text).toContain(`  origin keeps batch/x, which is harmless; deleting it, \`git -C '${clone}' push origin --delete batch/x\`, ` +
    'needs a bypass if a ruleset protects batch/*')
  expect(text).toContain(`  ${join(clone, review)} is this run's branch review and its record: keep it or delete it, ` +
    'but do not commit it')

  git(['checkout', '-q', '-b', 'elsewhere'], clone)
  git(['push', '-q', 'origin', '--delete', 'batch/x'], other)
  run.batch.merge_commit = revParse(clone, 'main')
  const later = await renderRunPhasePrompt(run, ROOT)
  expect(later).not.toContain('pull --ff-only')
  expect(later).not.toContain('origin keeps')
  run.batch.merge_commit = 'f00dfeed00000000000000000000000000000000'
  expect(await renderRunPhasePrompt(run, ROOT)).toContain(`  git -C '${clone}' fetch origin main:main  # main predates`)

  run.batch.merged_at_ms = null
  expect(await renderRunPhasePrompt(run, ROOT)).not.toContain('branch review')
})
