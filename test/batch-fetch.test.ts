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

/** A batch checkout, as the ship prompt has the orchestrator make it, with a submodule bootstrap initialised. */
function bootstrappedCheckout(clone: string, other: string): string {
  const sub = tempDir('hpipe-sub-')
  git(['init', '-q', '--initial-branch=main', '.'], sub)
  commitAs(sub, 'sdk.h', 'sdk\n')
  git(['checkout', '-q', '-B', 'batch/x', 'origin/batch/x'], other)
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sdk'], other)
  git(['commit', '-qm', 'chore: vendor the sdk'], other)
  git(['push', '-q', 'origin', 'HEAD:refs/heads/batch/x'], other)
  git(['fetch', '-q', 'origin', '+refs/heads/batch/x:refs/remotes/origin/batch/x'], clone)
  const checkout = join(tempDir('hpipe-checkouts-'), 'r1')
  git(['worktree', 'add', '-q', '--detach', checkout, 'origin/batch/x'], clone)
  git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'], checkout)
  return checkout
}

// The trial's `worktree remove` of a bootstrapped batch checkout failed: "working trees containing
// submodules cannot be moved or removed". Measured on a live run.
test('a batch checkout with submodules is removed with --force once nothing in it is uncommitted', async () => {
  const { cleanupLines } = await import('../src/supervisor/deliver')
  const { clone, other } = landingRepo()
  const checkout = bootstrappedCheckout(clone, other)
  const run = runIn(clone, [])
  run.batch = { ...run.batch!, checkout }

  expect(await cleanupLines(run, run.batch)).toContain(`  git -C '${clone}' worktree remove --force '${checkout}'` +
    '  # git refuses its submodules without --force; nothing in them is unpushed')

  const review = (reasons: string) => `  ${checkout} has ${reasons}: review it before adding --force, which its ` +
    'submodules need and which deletes their git data in this checkout'
  writeFileSync(join(checkout, 'sdk', 'sdk.h'), 'edited in the batch checkout\n')
  const dirty = await cleanupLines(run, run.batch)
  expect(dirty).toContain(`  git -C '${clone}' worktree remove '${checkout}'`)
  expect(dirty).toContain(review('uncommitted work (sdk)'))

  // A commit in the submodule that nothing pushed lives only in this checkout's submodule git data.
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-qam', 'local fix'], join(checkout, 'sdk'))
  expect(await cleanupLines(run, run.batch)).toContain(review('uncommitted work (sdk); submodules not at the commit ' +
    'it records (sdk); submodule commits on no remote branch (sdk)'))

  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-qam', 'chore: take the local fix'], checkout)
  expect(await cleanupLines(run, run.batch)).toContain(review('submodule commits on no remote branch (sdk)'))
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
  // The trial's batch was deleted by GitHub on merge, and its origin/ ref stayed. Measured on a live run.
  expect(later).toContain(`  git -C '${clone}' branch -dr origin/batch/x  # origin no longer has it`)
  run.batch.merge_commit = 'f00dfeed00000000000000000000000000000000'
  expect(await renderRunPhasePrompt(run, ROOT)).toContain(`  git -C '${clone}' fetch origin main:main  # main predates`)

  run.batch.merged_at_ms = null
  expect(await renderRunPhasePrompt(run, ROOT)).not.toContain('branch review')

  run.batch.merged_at_ms = 1
  run.artifacts.verdicts = { 'branch-review-0': join(tempDir('hpipe-state-'), 'r1-branch-review-0.md') }
  writeFileSync(run.artifacts.verdicts['branch-review-0']!, 'VERDICT: CLEAR\n')
  expect(await renderRunPhasePrompt(run, ROOT)).not.toContain('branch review')
})

// Smoke run 14: a per-task run's done notice had no clean-up block at all.
test('a per-task run\'s done notice cleans up the branches of merged PRs and the stale default branch', async () => {
  const { renderRunPhasePrompt } = await import('../src/supervisor/deliver')
  const { clone, other, t1 } = landingRepo()
  const t3Merged = revParse(other, 't3-branch')
  git(['checkout', '-q', 't3-branch'], other)
  commitAs(other, 'src/after.ts', 'pushed after PR #56 merged\n')
  git(['push', '-q', 'origin', 't3-branch'], other)
  const t3After = revParse(other, 't3-branch')
  git(['fetch', '-q', 'origin'], clone)
  git(['branch', 't1-branch', 'origin/t1-branch'], clone)
  git(['branch', 't3-branch', 'origin/t3-branch'], clone)

  const merged = (over: Partial<Task>) => mkTask({ phase: 'done', merged_at_ms: 1, ...over })
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: clone, repoRoot: clone, title: 'a' })
  run.phase = 'done'
  run.tasks = [
    merged({
      task_id: 't1', branch: 't1-branch', pr: 55, ci_head: { sha: t1, seen_at: 0 }, merge_commit: 'f00dfeed'.repeat(5),
    }),
    merged({ task_id: 't3', branch: 't3-branch', pr: 56, ci_head: { sha: t3Merged, seen_at: 0 } }),
    mkTask({ task_id: 't4', branch: 't4-branch', phase: 'failed', pr: 57 }),
  ]
  const text = await renderRunPhasePrompt(run, join(import.meta.dir, '..'))
  expect(text).toContain('- t1 t1-branch (hp-1): done, PR #55 merged\n')
  expect(text).toContain('- t4 t4-branch (hp-1): failed\n')
  expect(text.slice(text.indexOf('Clean up when you are done with it:'))).toBe([
    'Clean up when you are done with it:',
    `  git -C '${clone}' push origin --delete t1-branch`,
    `  t3-branch has commits PR #56 did not merge: ${t3After.slice(0, 8)}; review before deleting`,
    `  git -C '${clone}' branch -D t1-branch`,
    `  local t3-branch has commits PR #56 did not merge: ${t3After.slice(0, 8)}; review before deleting`,
    `  git -C '${clone}' pull --ff-only  # main predates PR #55's merge`,
  ].join('\n'))

  git(['push', '-q', 'origin', '--delete', 't1-branch', 't3-branch'], other)
  git(['branch', '-D', 't1-branch', 't3-branch'], clone)
  run.tasks[0]!.merge_commit = revParse(clone, 'main')
  const pruneOnly = await renderRunPhasePrompt(run, join(import.meta.dir, '..'))
  expect(pruneOnly.slice(pruneOnly.indexOf('Clean up when you are done with it:'))).toBe([
    'Clean up when you are done with it:',
    `  git -C '${clone}' branch -dr origin/t1-branch origin/t3-branch  # origin no longer has them`,
  ].join('\n'))

  git(['branch', '-dr', 'origin/t1-branch', 'origin/t3-branch'], clone)
  expect(await renderRunPhasePrompt(run, join(import.meta.dir, '..'))).not.toContain('Clean up')
})
