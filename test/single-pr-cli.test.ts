import { afterEach, beforeEach, expect, test } from 'bun:test'
import { abortCleanupHead } from '../src/supervisor/deliver'
import { hpipeCommand as hpipeFor } from '../src/lib/render'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmodSync } from 'node:fs'
import { cmdAbort, cmdBatchCheck, cmdRewind } from '../src/cli'
import { forgetDispatchBases } from '../src/lib/dispatch-base'
import { cmdTask, fakeBeads } from './helpers/cmd-task'
import { cleanupFixtures, cloneOfRemote, commitAs, git, revParse, tempDir } from './helpers/git-worktree'
import { listRuns, newRun, saveRun, withBatch } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

let dir: string
let repoDir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'single-pr-cli-'))
  repoDir = mkdtempSync(join(tmpdir(), 'single-pr-repo-'))
  mkdirSync(join(repoDir, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(repoDir, '.claude', 'agents', 'core-dev.md'), '# core-dev\n')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
  forgetDispatchBases()
  cleanupFixtures()
})

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null,
  agent_status: 'unknown', phase: 'implement', phase_entered_at: 0,
  escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function perTaskRun(tasks: Partial<Task>[]): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks.map(mkTask)
  return run
}

const singlePrRun = (tasks: Partial<Task>[]): Run => withBatch(perTaskRun(tasks), batchFixture())

const saved = async (run: Run): Promise<Run> =>
  (await listRuns(dir, 'personal')).find((r) => r.run_id === run.run_id)!

test('a task cannot be rewound onto a row its run\'s mode skips', async () => {
  const perTask = perTaskRun([{ phase: 'implement' }])
  await saveRun(dir, perTask)
  for (const phase of ['land-queue', 'sync']) {
    const refused = await cmdRewind(ctx(), { runId: perTask.run_id, phase, taskId: 't1' })
    expect(refused.ok, phase).toBe(false)
    expect(refused.text, phase).toContain(`${phase} is not a phase of a per-task run`)
  }

  const singlePr = singlePrRun([{ phase: 'implement' }])
  await saveRun(dir, singlePr)
  const refused = await cmdRewind(ctx(), { runId: singlePr.run_id, phase: 'ci', taskId: 't1' })
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain('ci is not a phase of a single-PR run')
  expect((await saved(singlePr)).tasks[0]?.phase).toBe('implement')
})

test('a per-task run cannot be rewound onto a ship row', async () => {
  const run = perTaskRun([{ phase: 'done' }])
  await saveRun(dir, run)
  const refused = await cmdRewind(ctx(), { runId: run.run_id, phase: 'ship', taskId: null })
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain('ship is not a phase of a per-task run')
  expect((await saved(run)).phase).toBe('execute')
})

const register = (run: Run, branch: string, base = async (..._args: unknown[]) =>
  ({ commit: '1fb8a43', ref: 'origin/batch/x', fetchError: null })) =>
  cmdTask(ctx(), {
    branch, bead: 'hp-9', surface: 'core', notes: '', dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: run.run_id,
  }, undefined, base)

test('a single-PR task is never registered on the batch branch or the default branch', async () => {
  const run = singlePrRun([])
  await saveRun(dir, run)
  for (const branch of ['batch/x', 'main']) {
    const refused = await register(run, branch)
    expect(refused.ok, branch).toBe(false)
    expect(refused.text, branch).toContain(`--branch ${branch} is this run's`)
  }
  expect((await saved(run)).tasks).toEqual([])
})

test('a single-PR task is dispatched from the batch branch as just fetched', async () => {
  const run = singlePrRun([])
  await saveRun(dir, run)
  const asked: unknown[][] = []
  const out = await register(run, 'feat/y', async (...args: unknown[]) => {
    asked.push(args)
    return { commit: '9e06c26', ref: 'origin/batch/x', fetchError: null }
  })
  expect(out.ok).toBe(true)
  expect(asked).toEqual([[repoDir, [], 'batch/x']])
  expect(out.text).toContain('base: 9e06c26 (origin/batch/x as just fetched)')
})

// ——— a fix task registered while the run ships ———

const fixTask = (
  run: Run, shipped: (repoRoot: string, pr: number) => Promise<boolean | null> = async () => false, bead = 'hp-9',
) =>
  cmdTask(ctx(), {
    branch: 'fix/red-ci', bead, surface: 'core', notes: '', dependsOn: [], files: [], keepWorktree: false,
    repoKey: 'k', runId: run.run_id,
  }, fakeBeads(), async () => ({ commit: '9e06c26', ref: 'origin/batch/x', fetchError: null }), shipped)

test('a fix task registered while a single-PR run ships moves the run back to execute and reopens intake', async () => {
  for (const phase of ['branch-review', 'ship', 'ship-ci', 'ship-merge'] as const) {
    const run = singlePrRun([{ phase: 'done', merged_at_ms: 1 }])
    run.phase = phase
    run.intake_closed = true
    run.batch!.pr = 301
    run.batch!.head_sha_at_entry = 'h1'
    await saveRun(dir, run)
    const out = await fixTask(run, undefined, `hp-${phase}`)
    expect(out.ok, phase).toBe(true)
    expect(out.text, phase).toContain('run moved to execute: register any other fix, then')
    const after = await saved(run)
    expect(after.phase, phase).toBe('execute')
    expect(after.intake_closed, phase).toBe(false)
    expect(after.batch?.pr, phase).toBe(301)
    expect(after.batch?.head_sha_at_entry, phase).toBe('h1')
    expect(after.history.findLast((h) => h.task_id === undefined)?.why, phase).toBe('a fix task was registered')
    expect(after.tasks.map((t) => t.task_id), phase).toEqual(['t1', 't2'])
  }
})

test('once the batch PR has merged, no fix task is registered into the run', async () => {
  const run = singlePrRun([{ phase: 'done', merged_at_ms: 1 }])
  run.phase = 'ship-merge'
  run.batch!.pr = 301
  await saveRun(dir, run)
  const out = await fixTask(run, async () => true)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('the batch already shipped as PR #301')
  expect((await saved(run)).tasks).toHaveLength(1)
})

test('a per-task run in branch-review is refused as it always was', async () => {
  const run = perTaskRun([{ phase: 'done', merged_at_ms: 1 }])
  run.phase = 'branch-review'
  await saveRun(dir, run)
  const out = await fixTask(run)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('is in branch-review; this needs a run in intake, dispatch or execute')
})

// ——— rewinds ———

test('rewinding a task to implement forgets its reviewed head and keeps its submission and landings', async () => {
  const run = singlePrRun([{
    phase: 'merge', land_sha: 'L1', submission: { kind: 'implement', title: 'feat: x', head_sha: 'S1', at: 1, check: 'none' },
    landed: [{ title: 'feat: x', land_sha: 'L0', at: 1 }],
  }])
  await saveRun(dir, run)
  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' })).ok).toBe(true)
  const t1 = (await saved(run)).tasks[0]!
  expect(t1.land_sha).toBeUndefined()
  expect(t1.submission?.head_sha).toBe('S1')
  expect(t1.landed).toHaveLength(1)
})

test('a rewind into land-queue, sync or merge restores the reviewed head from the last landing, or is refused', async () => {
  for (const phase of ['land-queue', 'sync', 'merge']) {
    const run = singlePrRun([{ phase: 'done', bead: `hp-${phase}`, merged_at_ms: 9, merge_commit: 'L2', bead_closed_at_ms: 10,
      landed: [{ title: 'feat: x', land_sha: 'L1', at: 1 }, { title: 'feat: x', land_sha: 'L2', at: 2 }] }])
    await saveRun(dir, run)
    const rewound = await cmdRewind(ctx(), { runId: run.run_id, phase, taskId: 't1' })
    expect(rewound.text, phase).toStartWith(`rewound t1 to ${phase}`)
    const t1 = (await saved(run)).tasks[0]!
    expect(t1.land_sha, phase).toBe('L2')
    expect(t1.merged_at_ms, phase).toBeNull()
    expect(t1.bead_closed_at_ms, phase).toBeNull()

    const never = singlePrRun([{ phase: 'pr-review', bead: `hp-never-${phase}` }])
    await saveRun(dir, never)
    const refused = await cmdRewind(ctx(), { runId: never.run_id, phase, taskId: 't1' })
    expect(refused.ok, phase).toBe(false)
    expect(refused.text, phase).toContain('no reviewed head is recorded for t1: rewind it to a review row')
  }
})

test('a task rewound while the run reviews or ships moves the run back to execute; once shipped it is refused', async () => {
  for (const phase of ['branch-review', 'ship', 'ship-ci', 'ship-merge'] as const) {
    const run = singlePrRun([{
      phase: 'done', bead: `hp-${phase}`, merged_at_ms: 1, landed: [{ title: 'feat: x', land_sha: 'L1', at: 1 }],
    }])
    run.phase = phase
    run.intake_closed = true
    run.batch!.pr = phase === 'branch-review' ? null : 301
    await saveRun(dir, run)
    const out = await cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' }, async () => false)
    expect(out.ok, phase).toBe(true)
    expect(out.text, phase).toContain('the run moves back to execute')
    expect((await saved(run)).phase, phase).toBe('execute')
  }

  const shipped = singlePrRun([{ phase: 'done', merged_at_ms: 1 }])
  shipped.phase = 'ship-merge'
  shipped.batch!.pr = 301
  await saveRun(dir, shipped)
  const refused = await cmdRewind(ctx(), { runId: shipped.run_id, phase: 'implement', taskId: 't1' }, async () => true)
  expect(refused.ok).toBe(false)
  expect(refused.text).toContain('the batch already shipped as PR #301')
})

/** A supervisor saving the run on a short cadence, as `main.ts` saves every advancing run every tick. */
function liveSupervisor(run: Run): { stop: () => void } {
  const timer = setInterval(async () => {
    const meanwhile = await saved(run)
    meanwhile.history.push({ at: Date.now(), from: 'x', to: 'x', why: 'a supervisor tick' })
    await saveRun(dir, meanwhile).catch(() => {})
  }, 100)
  return { stop: () => clearInterval(timer) }
}

test('a rewind and a fix task while the run ships land against a live supervisor, asking GitHub once each', async () => {
  for (const command of ['rewind', 'register'] as const) {
    const run = singlePrRun([{ phase: 'done', merged_at_ms: 1, landed: [{ title: 'feat: x', land_sha: 'L1', at: 1 }] }])
    run.phase = 'ship-ci'
    run.intake_closed = true
    run.batch!.pr = 301
    await saveRun(dir, run)
    let asked = 0
    const slowGitHub = async () => { asked++; await Bun.sleep(400); return false }
    const supervisor = liveSupervisor(run)
    const out = await (command === 'rewind'
      ? cmdRewind(ctx(), { runId: run.run_id, phase: 'implement', taskId: 't1' }, slowGitHub)
      : fixTask(run, slowGitHub, 'hp-live')
    ).finally(() => supervisor.stop())
    expect(out.ok, `${command}: ${out.text}`).toBe(true)
    expect(asked, command).toBe(1)
    expect((await saved(run)).phase, command).toBe('execute')
  }
})

test('a run rewound to ship forgets the PR it found; to ship-ci, the bucket it read and its head', async () => {
  const run = singlePrRun([{ phase: 'done' }])
  run.phase = 'escalated'
  run.batch!.pr = 301
  run.batch!.ci = 'fail'
  run.batch!.ci_head = { sha: 'h0', seen_at: 0 }
  run.passes['ship-ci'] = 2
  await saveRun(dir, run)
  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'ship-ci', taskId: null })).ok).toBe(true)
  expect((await saved(run)).batch?.ci).toBeNull()
  expect((await saved(run)).batch?.ci_head).toBeUndefined()
  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'ship', taskId: null })).ok).toBe(true)
  const after = await saved(run)
  expect(after.batch?.pr).toBeNull()
  expect(after.passes).toEqual({})
})

// ——— abort ———

test('aborting a single-PR run names what landed and offers no clean-up for what was never made', async () => {
  const run = singlePrRun([
    { task_id: 't1', phase: 'done', merged_at_ms: 1, landed: [{ title: 'feat: a', land_sha: 'L1', at: 1 }] },
    { task_id: 't2', phase: 'implement', branch: 't2-branch' },
  ])
  await saveRun(dir, run)
  const out = await cmdAbort(ctx(), { runId: run.run_id })
  expect(out.ok).toBe(true)
  expect(out.text).toContain('batch/x keeps the landed tasks (t1), whose beads stay closed, and nothing reached main')
  expect(out.text).toContain('the unlanded tasks\' beads are released on the supervisor\'s next tick')
  expect(out.text).toContain(abortCleanupHead(hpipeFor(ctx().pluginRoot)))
  // Neither the batch checkout nor a local batch branch exists before ship: smoke run 19 was offered both.
  expect(out.text).not.toContain('worktree remove')
  expect(out.text).not.toContain('branch -D')
})

test('an aborted single-PR run lists each task worktree, the unlanded branches and the protected batch', async () => {
  const { clone } = cloneOfRemote('main')
  git(['push', '-q', 'origin', 'HEAD:refs/heads/batch/x'], clone)
  const clean = join(tempDir('hpipe-wt-'), 'feat-a')
  const dirty = join(tempDir('hpipe-wt-'), 'feat-b')
  git(['worktree', 'add', '-q', '-b', 'feat/a', clean, 'HEAD'], clone)
  git(['worktree', 'add', '-q', '-b', 'feat/b', dirty, 'HEAD'], clone)
  commitAs(dirty, 'src/b.ts', 'one\n')
  commitAs(dirty, 'src/b2.ts', 'two\n')
  git(['push', '-q', 'origin', 'feat/b'], dirty)
  writeFileSync(join(dirty, 'src', 'wip.ts'), 'unsaved\n')
  git(['fetch', '-q', 'origin'], clone)

  const run = withBatch(newRun({ session: 'personal', socketPath: '/s', repoKey: clone, repoRoot: clone, title: 'a' }),
    { ...batchFixture(), ruleset_protected: true })
  run.phase = 'execute'
  run.tasks = [
    mkTask({ task_id: 't1', bead: 'hp-1', branch: 'feat/a', workspace_id: 'w3', pane_id: 'w3:p1', checkout_path: clean }),
    mkTask({ task_id: 't2', bead: 'hp-2', branch: 'feat/b', workspace_id: 'w4', pane_id: 'w4:p1', checkout_path: dirty }),
  ]
  await saveRun(dir, run)
  const out = await cmdAbort(ctx(), { runId: run.run_id })
  const block = out.text.slice(out.text.indexOf(abortCleanupHead(hpipeFor(ctx().pluginRoot)))).split('\n')
  const expected = [
    abortCleanupHead(hpipeFor(ctx().pluginRoot)),
    `  herdr worktree remove --workspace w3  # t1's checkout ${clean}; closes its agent and keeps feat/a`,
    `  t2's checkout ${dirty} has uncommitted work (src/wip.ts): review it before \`herdr worktree remove --workspace w4\``,
    `  git -C '${clone}' branch -D feat/a  # origin has every commit on it`,
    `  feat/b on origin has 2 commits that did not land, up to ${revParse(dirty, 'HEAD').slice(0, 8)}; review before ` +
      'deleting',
    '  origin keeps batch/x, which the ruleset on batch/* protects from deletion: leave it',
    '  beads hp-1, hp-2 stay open, labelled aborted: a later run adopts them with `hpipe task --bead <id>` rather ' +
      'than filing new ones, or the user closes them',
  ]
  expect(block).toEqual(expected)

  // Nothing else prints it once this output is gone, so a second abort does.
  const again = await cmdAbort(ctx(), { runId: run.run_id })
  expect(again.ok).toBe(false)
  expect(again.text.slice(again.text.indexOf(abortCleanupHead(hpipeFor(ctx().pluginRoot)))).split('\n')).toEqual(expected)
})

test('an aborted run keeps the batch that holds a landing, and an unpushed local batch, and names a moved checkout', async () => {
  const { clone } = cloneOfRemote('main')
  git(['checkout', '-q', '-b', 't1-branch'], clone)
  commitAs(clone, 'src/t1.ts', 't1\n')
  git(['push', '-q', 'origin', 't1-branch', 'HEAD:refs/heads/batch/x'], clone)
  git(['checkout', '-q', '-b', 'batch/x', 'origin/batch/x'], clone)
  commitAs(clone, 'src/repair.ts', 'a ship repair never pushed\n')
  const repair = revParse(clone, 'HEAD')
  git(['checkout', '-q', 'main'], clone)
  const moved = join(tempDir('hpipe-wt-'), 'feat-b')
  git(['worktree', 'add', '-q', '-b', 'other', moved, 'main'], clone)
  git(['fetch', '-q', 'origin'], clone)

  const run = withBatch(newRun({ session: 'personal', socketPath: '/s', repoKey: clone, repoRoot: clone, title: 'a' }),
    { ...batchFixture(), ruleset_protected: true })
  run.phase = 'execute'
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'done', landed: [{ title: 'feat: t1', land_sha: 'L1', at: 1 }] }),
    mkTask({ task_id: 't2', branch: 'feat/b', workspace_id: 'w4', pane_id: 'w4:p1', checkout_path: moved }),
  ]
  await saveRun(dir, run)
  const out = await cmdAbort(ctx(), { runId: run.run_id })
  expect(out.text.slice(out.text.indexOf(abortCleanupHead(hpipeFor(ctx().pluginRoot)))).split('\n')).toEqual([
    abortCleanupHead(hpipeFor(ctx().pluginRoot)),
    `  t2's checkout ${moved} is on other, not feat/b: review it before \`herdr worktree remove --workspace w4\``,
    `  git -C '${clone}' branch -D t1-branch  # origin has every commit on it`,
    `  git -C '${clone}' push origin --delete t1-branch`,
    `  local batch/x has 1 commit not on origin/batch/x, up to ${repair.slice(0, 8)}; review before deleting`,
    '  origin keeps batch/x, the only copy of what t1 landed: keep it',
    '  bead hp-1 stays open, labelled aborted: a later run adopts it with `hpipe task --bead <id>` rather than ' +
      'filing new ones, or the user closes it',
  ])
})

test('an aborted per-task run lists its worktree and the open PR\'s unmerged branch', async () => {
  const { clone } = cloneOfRemote('main')
  const checkout = join(tempDir('hpipe-wt-'), 'feat-x')
  git(['worktree', 'add', '-q', '-b', 'feat/x', checkout, 'main'], clone)
  commitAs(checkout, 'src/x.ts', 'x\n')
  git(['push', '-q', 'origin', 'feat/x'], checkout)
  git(['fetch', '-q', 'origin'], clone)

  // A worker's commit made but never pushed: herdr's removal keeps the branch, and only it holds the commit.
  git(['branch', 'feat/local', 'main'], clone)
  git(['checkout', '-q', 'feat/local'], clone)
  commitAs(clone, 'src/local.ts', 'never pushed\n')
  const local = revParse(clone, 'HEAD')
  git(['checkout', '-q', 'main'], clone)

  const run = perTaskRun([
    { task_id: 't1', bead: 'hp-1', branch: 'feat/x', phase: 'ci', pr: 12, workspace_id: 'w3', pane_id: 'w3:p1',
      checkout_path: checkout },
    { task_id: 't2', bead: 'hp-2', branch: 'feat/local', phase: 'implement' },
  ])
  run.repo_root = clone
  await saveRun(dir, run)
  const out = await cmdAbort(ctx(), { runId: run.run_id })
  expect(out.text.slice(out.text.indexOf(abortCleanupHead(hpipeFor(ctx().pluginRoot)))).split('\n')).toEqual([
    abortCleanupHead(hpipeFor(ctx().pluginRoot)),
    `  herdr worktree remove --workspace w3  # t1's checkout ${checkout}; closes its agent and keeps feat/x`,
    `  git -C '${clone}' branch -D feat/x  # origin has every commit on it`,
    `  local feat/local has 1 commit no branch on origin has, up to ${local.slice(0, 8)}; push it or review before ` +
      'deleting',
    `  feat/x on origin (PR #12, left open) has 1 commit not on main, up to ${revParse(checkout, 'HEAD').slice(0, 8)}; ` +
      'review before deleting',
    '  beads hp-1, hp-2 stay open, labelled aborted: a later run adopts them with `hpipe task --bead <id>` rather ' +
      'than filing new ones, or the user closes them',
  ])
})

// ——— batch-check ———

async function shippingRun(check: string | null): Promise<{ run: Run; checkout: string; clone: string; remote: string }> {
  const { remote, clone } = cloneOfRemote('main')
  if (check !== null) {
    commitAs(clone, '.claude/pipeline-check', check)
    chmodSync(join(clone, '.claude', 'pipeline-check'), 0o755)
    git(['add', '-A'], clone)
    git(['commit', '-qm', 'chore: executable check'], clone)
  }
  git(['push', '-q', 'origin', 'HEAD:refs/heads/batch/x'], clone)
  git(['fetch', '-q', 'origin', '+refs/heads/batch/x:refs/remotes/origin/batch/x'], clone)
  const checkout = join(tempDir('hpipe-batch-'), 'r1')
  git(['worktree', 'add', '-q', '--track', '-B', 'batch/x', checkout, 'origin/batch/x'], clone)
  const run = withBatch(newRun({ session: 'personal', socketPath: '/s', repoKey: clone, repoRoot: clone, title: 'a' }),
    batchFixture({ checkout }))
  run.phase = 'ship'
  await saveRun(dir, run)
  return { run, checkout, clone, remote }
}

test('batch-check runs the check in the batch checkout at the fetched head, and records that head', async () => {
  const { run, clone } = await shippingRun('#!/bin/sh\necho combined\nexit 0\n')
  const out = await cmdBatchCheck(ctx(), { repoKey: null, runId: run.run_id })
  expect(out.ok).toBe(true)
  const head = revParse(clone, 'refs/remotes/origin/batch/x')
  expect(out.text).toContain(`checked batch/x at ${head.slice(0, 8)}: .claude/pipeline-check passed`)
  expect((await saved(run)).batch?.checked).toMatchObject({ head_sha: head, check: 'passed' })
})

test('batch-check refuses a red check, a checkout behind the batch, and a missing checkout', async () => {
  const red = await shippingRun('#!/bin/sh\necho broken\nexit 1\n')
  const failed = await cmdBatchCheck(ctx(), { repoKey: null, runId: red.run.run_id })
  expect(failed.ok).toBe(false)
  expect(failed.text).toContain('broken')
  expect((await saved(red.run)).batch?.checked).toBeUndefined()

  const behind = await shippingRun(null)
  const other = join(tempDir('hpipe-other-'), 'o')
  git(['clone', '-q', '--branch', 'batch/x', behind.remote, other], tempDir('cwd-'))
  commitAs(other, 'src/x.ts', 'x')
  git(['push', '-q', 'origin', 'HEAD:batch/x'], other)
  const stale = await cmdBatchCheck(ctx(), { repoKey: null, runId: behind.run.run_id })
  expect(stale.ok).toBe(false)
  expect(stale.text).toContain('pull --ff-only')

  rmSync(behind.checkout, { recursive: true, force: true })
  const missing = await cmdBatchCheck(ctx(), { repoKey: null, runId: behind.run.run_id })
  expect(missing.ok).toBe(false)
  expect(missing.text).toContain('worktree add --track -B batch/x')
})

test('batch-check records its head against a live supervisor, running the check once', async () => {
  const { run, clone } = await shippingRun('#!/bin/sh\nsleep 1\nexit 0\n')
  let checks = 0
  const supervisor = liveSupervisor(run)
  const out = await cmdBatchCheck(ctx(), { repoKey: null, runId: run.run_id }, async (checkout, log) => {
    checks++
    const { runCheck } = await import('../src/lib/check')
    return runCheck(checkout, log)
  }).finally(() => supervisor.stop())
  expect(out.ok, out.text).toBe(true)
  expect(checks).toBe(1)
  expect((await saved(run)).batch?.checked?.head_sha).toBe(revParse(clone, 'refs/remotes/origin/batch/x'))
})

test('with no check declared, batch-check still records the head, as unchecked', async () => {
  const { run } = await shippingRun(null)
  const out = await cmdBatchCheck(ctx(), { repoKey: null, runId: run.run_id })
  expect(out.ok).toBe(true)
  // The trial's "checked batch/… at 2da97b97" with no check declared claimed a check nothing ran.
  // Measured on a live run.
  expect(out.text).toStartWith('recorded batch/x at ')
  expect(out.text).toContain(': nothing checked it, since no .claude/pipeline-check is declared — run the tests and ' +
    'the typecheck in ')
  expect(out.text).not.toContain('checked batch')
  expect((await saved(run)).batch?.checked?.check).toBe('none')
})
