import { afterEach, expect, test } from 'bun:test'
import { newRun, withBatch } from '../src/lib/ledger'
import type { Run, Submission, Task } from '../src/lib/types'
import { advanceTasks, type LandingGit, type TaskDeps } from '../src/supervisor/tasks'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'
import { cleanupFixtures } from './helpers/git-worktree'

afterEach(cleanupFixtures)

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'queued', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/t1', registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function singlePrRun(tasks: Task[]): Run {
  const run = withBatch(newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' }),
    batchFixture())
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  return run
}

const deps = (over: Partial<TaskDeps> = {}): TaskDeps => ({
  pluginRoot: process.cwd(),
  liveIdle: async () => true,
  hasLiveAgent: () => true,
  maxPasses: 2,
  fileSettleMs: 0,
  prForBranch: async () => null,
  prView: async () => null,
  verdictFor: async () => null,
  removeWorktree: async () => 'removed',
  removeCheckout: async () => ({ removed: true }),
  ciDetail: async () => '',
  ambiguityLog: new Set<string>(),
  uncommittedPaths: async () => [],
  freshDispatchBase: async () => ({ commit: '1fb8a43', ref: 'origin/batch/x', fetchError: null }),
  ...over,
})

test('a single-PR task opened by its gate is cut from the batch branch', async () => {
  const asked: Array<string | null> = []
  const run = singlePrRun([mkTask({})])
  const prompts = await advanceTasks(run, deps({
    freshDispatchBase: async (_root, _merges, branch) => {
      asked.push(branch)
      return { commit: '9e06c26', ref: 'origin/batch/x', fetchError: null }
    },
  }))
  expect(asked).toEqual(['batch/x'])
  expect(prompts[0]?.text).toContain('base: 9e06c26 (origin/batch/x as just fetched)')
})

// ——— landing ———

const BATCH_REF = 'refs/remotes/origin/batch/x'

/**
 * Ancestry as a set of `a>b` pairs ("a is an ancestor of b"), with the batch ref
 * standing for its head. Every commit is its own ancestor.
 */
function fakeGit(over: {
  batchHead?: string; heads?: Record<string, string | null>; ancestors?: string[]
  changed?: Record<string, string[]>; broken?: boolean; unreachable?: boolean
} = {}): LandingGit & { lsRemotes: string[] } {
  const batchHead = over.batchHead ?? 'b0'
  const pairs = new Set(over.ancestors ?? [])
  const resolve = (ref: string) => (ref === BATCH_REF ? batchHead : ref)
  const lsRemotes: string[] = []
  return {
    lsRemotes,
    isAncestor: async (_root, a, b) => (over.broken ? null : resolve(a) === resolve(b) || pairs.has(`${resolve(a)}>${resolve(b)}`)),
    remoteBranchHead: async (_root, branch) => {
      lsRemotes.push(branch)
      return over.unreachable ? { ok: false, reason: 'unreachable' } : { ok: true, sha: over.heads?.[branch] ?? null }
    },
    resolve: async (_root, ref) => resolve(ref),
    changedPaths: async (_root, from, to) => over.changed?.[`${from}..${to}`] ?? ['src/menu.ts'],
  }
}

const submitted = (over: Partial<Submission> = {}): Submission => ({
  kind: 'implement', title: 'feat(menu): close', head_sha: 'L1', at: 0, check: 'passed', ...over,
})

const waiting = (id: string, over: Partial<Task> = {}): Task => mkTask({
  task_id: id, branch: `${id}-branch`, phase: 'land-queue', land_sha: `L${id.slice(1)}`, pane_id: `w${id}:p1`,
  phase_entered_at: 10, submission: submitted({ head_sha: `L${id.slice(1)}` }), ...over,
})

test('a waiting task stays put while another holds the landing slot', async () => {
  const holder = mkTask({ task_id: 't1', phase: 'sync', land_sha: 'L1', phase_entered_at: Date.now() })
  const run = singlePrRun([holder, waiting('t2')])
  const git = fakeGit({ ancestors: ['b0>L2'] })
  await advanceTasks(run, deps({ landingGit: git }))
  expect(run.tasks[1]?.phase).toBe('land-queue')
})

test('the oldest in line takes the slot, and only it, even when both entered in one tick', async () => {
  const run = singlePrRun([waiting('t1', { phase_entered_at: 20 }), waiting('t2', { phase_entered_at: 10 })])
  await advanceTasks(run, deps({ landingGit: fakeGit({ ancestors: ['b0>L1', 'b0>L2'] }) }))
  expect(run.tasks.map((t) => t.phase)).toEqual(['land-queue', 'merge'])
})

test('a paneless task that must sync is passed over, so it cannot hold every landing up', async () => {
  const run = singlePrRun([waiting('t1', { phase_entered_at: 1, pane_id: null }), waiting('t2', { phase_entered_at: 9 })])
  await advanceTasks(run, deps({ landingGit: fakeGit() }))
  expect(run.tasks.map((t) => t.phase)).toEqual(['land-queue', 'sync'])
})

test('a paneless task that lands without a sync still takes its turn: merge needs no worker', async () => {
  const run = singlePrRun([waiting('t1', { phase_entered_at: 1, pane_id: null }), waiting('t2', { phase_entered_at: 9 })])
  await advanceTasks(run, deps({ landingGit: fakeGit({ ancestors: ['b0>L1', 'b0>L2'] }) }))
  expect(run.tasks.map((t) => t.phase)).toEqual(['merge', 'land-queue'])
})

test('with the slot: up to date and checked lands; behind syncs', async () => {
  const ready = singlePrRun([waiting('t1')])
  await advanceTasks(ready, deps({ landingGit: fakeGit({ ancestors: ['b0>L1'] }) }))
  expect(ready.tasks[0]?.phase).toBe('merge')
  const behind = singlePrRun([waiting('t1')])
  await advanceTasks(behind, deps({ landingGit: fakeGit() }))
  expect(behind.tasks[0]?.phase).toBe('sync')
})

test('a reviewer\'s inline fix after the submission is unchecked, so the task syncs to check it', async () => {
  const fixed = singlePrRun([waiting('t1', { submission: submitted({ head_sha: 'S1' }) })])
  await advanceTasks(fixed, deps({ landingGit: fakeGit({ ancestors: ['b0>L1'], changed: { 'S1..L1': ['src/menu.ts'] } }) }))
  expect(fixed.tasks[0]?.phase).toBe('sync')

  const verdictsOnly = singlePrRun([waiting('t1', { submission: submitted({ head_sha: 'S1' }) })])
  await advanceTasks(verdictsOnly, deps({ landingGit: fakeGit({
    ancestors: ['b0>L1'], changed: { 'S1..L1': ['docs/superpowers/reviews/hp-1-pr-review-1.md'] },
  }) }))
  expect(verdictsOnly.tasks[0]?.phase).toBe('merge')
})

test('a branch moved past its reviewed head syncs, unless the move is review verdicts alone', async () => {
  const moved = singlePrRun([mkTask({ task_id: 't1', phase: 'merge', land_sha: 'L1', submission: submitted() })])
  await advanceTasks(moved, deps({ landingGit: fakeGit({ ancestors: ['b0>L1'], heads: { 't1-branch': 'X1' } }) }))
  expect(moved.tasks[0]?.phase).toBe('sync')

  const verdicts = singlePrRun([mkTask({ task_id: 't1', phase: 'merge', land_sha: 'L1', submission: submitted() })])
  await advanceTasks(verdicts, deps({ landingGit: fakeGit({
    ancestors: ['b0>L1', 'L1>b0'], heads: { 't1-branch': 'X1' },
    changed: { 'L1..X1': ['docs/superpowers/reviews/hp-1-pr-review-2.md'] },
  }) }))
  expect(verdicts.tasks[0]?.phase).toBe('close')
})

test('merge records a landing seen on the batch, and a deleted task branch does not hide it', async () => {
  const run = singlePrRun([mkTask({ task_id: 't1', phase: 'merge', land_sha: 'L1', submission: submitted() })])
  await advanceTasks(run, deps({ landingGit: fakeGit({ batchHead: 'L1', heads: { 't1-branch': null } }) }))
  expect(run.tasks[0]?.phase).toBe('close')
  expect(run.tasks[0]?.landed?.map((l) => l.land_sha)).toEqual(['L1'])
})

test('a git read that fails skips the tick rather than reading as not landed', async () => {
  for (const phase of ['merge', 'land-queue'] as const) {
    const run = singlePrRun([mkTask({ task_id: 't1', phase, land_sha: 'L1', submission: submitted() })])
    await advanceTasks(run, deps({ landingGit: fakeGit({ broken: true }) }))
    expect(run.tasks[0]?.phase, phase).toBe(phase)
    const offline = singlePrRun([mkTask({ task_id: 't1', phase, land_sha: 'L1', submission: submitted() })])
    await advanceTasks(offline, deps({ landingGit: fakeGit({ ancestors: ['b0>L1'], unreachable: true }) }))
    expect(offline.tasks[0]?.phase, phase).toBe(phase)
  }
})

test('the last review\'s CLEAR records the branch head origin has, and a failed read waits', async () => {
  const CLEAR = { verdict: 'CLEAR' as const, blockers: 0, majors: 0 }
  const run = singlePrRun([mkTask({ phase: 'pr-review', tier: 'light', submission: submitted({ head_sha: 'S1' }) })])
  await advanceTasks(run, deps({
    verdictFor: async () => CLEAR, landingGit: fakeGit({ heads: { 't1-branch': 'H1' }, ancestors: ['S1>H1'] }),
  }))
  expect(run.tasks[0]?.phase).toBe('land-queue')
  expect(run.tasks[0]?.land_sha).toBe('H1')

  const offline = singlePrRun([mkTask({ phase: 'pr-review', tier: 'light', submission: submitted() })])
  await advanceTasks(offline, deps({ verdictFor: async () => CLEAR, landingGit: fakeGit({ unreachable: true }) }))
  expect(offline.tasks[0]?.phase).toBe('pr-review')
})

test('a single-PR send-back reads the branch head from origin, never a PR', async () => {
  const BLOCKER = { verdict: 'BLOCKER' as const, blockers: 1, majors: 0 }
  const run = singlePrRun([mkTask({ phase: 'pr-review', tier: 'light', submission: submitted() })])
  await advanceTasks(run, deps({
    verdictFor: async () => BLOCKER, prForBranch: async () => { throw new Error('no PR in a single-PR run') },
    landingGit: fakeGit({ heads: { 't1-branch': 'H2' } }),
  }))
  expect(run.tasks[0]?.phase).toBe('implement')
  expect(run.tasks[0]?.head_sha_at_entry).toBe('H2')
})

test('a sync with no agent gets its brief and sync prompt queued once, not again while queued', async () => {
  const run = singlePrRun([mkTask({ phase: 'sync', pane_id: null, land_sha: 'L1', submission: submitted() })])
  const git = fakeGit()
  await advanceTasks(run, deps({ landingGit: git }))
  await advanceTasks(run, deps({ landingGit: git }))
  expect(run.outbox).toHaveLength(1)
  expect(run.outbox?.[0]).toMatchObject({ to: 'worker', task_id: 't1' })
  expect(run.outbox?.[0]?.text).toContain('# t1-branch — hp-1')
  expect(run.outbox?.[0]?.text).toContain('# Sync — t1-branch (hp-1) with `batch/x`')
})

test('a task sent to sync with no agent has its prompt queued, not dropped', async () => {
  const run = singlePrRun([waiting('t1', { pane_id: null, phase: 'merge' })])
  const prompts = await advanceTasks(run, deps({ landingGit: fakeGit({ batchHead: 'b1' }) }))
  expect(run.tasks[0]?.phase).toBe('sync')
  expect(prompts).toEqual([])
  expect(run.outbox?.[0]?.text).toContain('# Sync — t1-branch')
})

test('a sync holder with nothing submitted past its window yields the slot to a waiting task', async () => {
  const stuck = mkTask({ task_id: 't1', phase: 'sync', land_sha: 'L1', phase_entered_at: Date.now() - 16 * 60_000 })
  const run = singlePrRun([stuck, waiting('t2')])
  await advanceTasks(run, deps({ landingGit: fakeGit(), syncYieldMs: 15 * 60_000, liveIdle: async () => false }))
  expect(run.tasks[0]?.phase).toBe('land-queue')
  expect(run.tasks[0]?.land_sha).toBe('L1')
  expect(run.history.find((h) => h.task_id === 't1')?.why).toBe('yielded the landing slot: no sync after 15m, t2 waiting')
  expect(run.tasks[1]?.phase).toBe('sync')
})

test('a landed task rewound into sync records its landing instead of waiting on a no-op merge', async () => {
  const run = singlePrRun([mkTask({ phase: 'sync', land_sha: 'L1', pane_id: null, submission: submitted() })])
  await advanceTasks(run, deps({ landingGit: fakeGit({ batchHead: 'b9', ancestors: ['L1>b9'], heads: { 't1-branch': 'L1' } }) }))
  expect(run.tasks[0]?.phase).toBe('merge')
})
