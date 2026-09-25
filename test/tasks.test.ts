import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { advanceTasks, promptForTaskPhase } from '../src/supervisor/tasks'
import { absoluteArtifactPath } from '../src/supervisor/deliver'
import { loadRun, newRun, type RunEffect, saveOrReapply, saveRun } from '../src/lib/ledger'
import { counterFor } from '../src/lib/machine'
import type { Run, Task } from '../src/lib/types'
import { cleanupFixtures, commitIn, repoWithWorktree, tempDir } from './helpers/git-worktree'

afterEach(cleanupFixtures)

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'queued', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function mkRun(tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  return run
}

const deps = (over: Partial<Parameters<typeof advanceTasks>[1]> = {}) => ({
  pluginRoot: process.cwd(),
  liveIdle: async () => true,
  maxPasses: 2,
  fileSettleMs: 0,
  prForBranch: async () => null,
  prView: async () => null,
  issueView: async () => null,
  verdictFor: async () => null,
  removeWorktree: async () => 'removed' as const,
  ciDetail: async () => '',
  ambiguityLog: new Set<string>(),
  uncommittedPaths: async () => [],
  freshDispatchBase: async () => 'origin/main',
  ...over,
})

test('an unblocked queued task is dispatched and yields a dispatch prompt', async () => {
  const run = mkRun([mkTask({})])
  const prompts = await advanceTasks(run, deps())
  expect(prompts.map((p) => p.text).join('\n')).toContain('feat/x')
})

test('an opened gate dispatches into the design loop, not straight to implement', async () => {
  const run = mkRun([mkTask({ task_id: 't1', phase: 'queued' })])
  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('research')
})

test('advanceTasks releases a blocked-on-files task once its sibling settles', async () => {
  const run = mkRun([
    mkTask({ task_id: 't1', phase: 'done', files: ['a/'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] }),
  ])
  await advanceTasks(run, deps())
  expect(run.tasks[1]?.phase).toBe('implement')
})

function checkoutWithPlan(planText: string): { checkout_path: string; artifacts: Task['artifacts'] } {
  const checkout = tempDir('hpipe-plan-files-')
  const plan = 'docs/superpowers/plans/plan.md'
  mkdirSync(join(checkout, dirname(plan)), { recursive: true })
  writeFileSync(join(checkout, plan), planText)
  return { checkout_path: checkout, artifacts: { research: null, spec: null, plan, verdicts: {} } }
}

test('a file the plan discovered keeps the task off a sibling that holds it', async () => {
  const run = mkRun([
    mkTask({ task_id: 't1', phase: 'implement', files: ['src/deliver.ts'] }),
    mkTask({
      task_id: 't2', phase: 'blocked-on-files', files: ['src/cli.ts'],
      ...checkoutWithPlan('# Plan\n\nFILES: src/cli.ts, src/deliver.ts\n'),
    }),
  ])
  await advanceTasks(run, deps())
  expect(run.tasks[1]?.phase).toBe('blocked-on-files')
  expect(run.tasks[1]?.files).toEqual(['src/cli.ts', 'src/deliver.ts'])
})

test('a plan path written under the worker\'s checkout is locked repo-relative', async () => {
  const waiter = mkTask({ task_id: 't2', phase: 'blocked-on-files', files: [] })
  Object.assign(waiter, checkoutWithPlan(''))
  writeFileSync(
    join(waiter.checkout_path as string, waiter.artifacts.plan as string),
    `FILES: ${waiter.checkout_path}/src/deliver.ts\n`,
  )
  const run = mkRun([mkTask({ task_id: 't1', phase: 'implement', files: ['src/'] }), waiter])
  await advanceTasks(run, deps())
  expect(waiter.files).toEqual(['src/deliver.ts'])
  expect(waiter.phase).toBe('blocked-on-files')
})

test('a plan listing the artifact directory does not serialise it behind a sibling on docs', async () => {
  const waiter = mkTask({
    task_id: 't1', phase: 'blocked-on-files', files: ['src/greet.ts'],
    ...checkoutWithPlan('FILES: test/greet.test.ts, docs/superpowers/\n'),
  })
  const run = mkRun([waiter, mkTask({ task_id: 't3', phase: 'implement', files: ['docs'] })])

  const seen: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { seen.push(args.join(' ')) }
  try {
    await advanceTasks(run, deps())
  } finally {
    console.error = original
  }

  expect(waiter.files).toEqual(['src/greet.ts', 'test/greet.test.ts'])
  expect(waiter.phase).toBe('implement')
  expect(seen.filter((line) => line.includes('plan widened files'))).toEqual([
    '[pipeline] t1 (feat/x): plan widened files by test/greet.test.ts ' +
    '(ignored pipeline artifacts: docs/superpowers/)',
  ])
})

test('two tasks whose plans each discover the other\'s files run one after the other', async () => {
  const run = mkRun([
    mkTask({
      task_id: 't1', phase: 'blocked-on-files', files: ['a/'],
      ...checkoutWithPlan('FILES: a/, b/\n'),
    }),
    mkTask({
      task_id: 't2', phase: 'blocked-on-files', files: ['b/'],
      ...checkoutWithPlan('FILES: b/, a/\n'),
    }),
  ])
  await advanceTasks(run, deps())
  expect(run.tasks.map((t) => t.phase)).toEqual(['implement', 'blocked-on-files'])

  const first = run.tasks[0] as Task
  first.phase = 'done'
  await advanceTasks(run, deps())
  expect(run.tasks[1]?.phase).toBe('implement')
})

test('a worker row reads the worker pane live, not the cached agent_status', async () => {
  const run = mkRun([mkTask({ phase: 'spec', pane_id: 'w7:p1', agent_status: 'idle' })])
  const reads: string[] = []
  await advanceTasks(run, deps({
    liveIdle: async (pane: string) => { reads.push(pane); return false },
  }))
  expect(reads).toEqual(['w7:p1'])
  expect(run.tasks[0]?.phase).toBe('spec')
})

test('an orchestrator row reads the orchestrator pane', async () => {
  const run = mkRun([mkTask({ phase: 'merge', pane_id: 'w7:p1' })])
  run.orchestrator_pane = 'w1:p1'
  const reads: string[] = []
  await advanceTasks(run, deps({
    liveIdle: async (pane: string) => { reads.push(pane); return true },
  }))
  expect(reads).toEqual(['w1:p1'])
})

test('a task with no pane is skipped, not errored', async () => {
  const run = mkRun([mkTask({ phase: 'research', pane_id: null })])
  await expect(advanceTasks(run, deps())).resolves.toBeDefined()
  expect(run.tasks[0]?.phase).toBe('research')
})

test('a gated queued task stays queued and yields nothing', async () => {
  const run = mkRun([
    mkTask({ task_id: 't1', phase: 'implement' }),
    mkTask({ task_id: 't2', depends_on: ['t1'] }),
  ])
  const prompts = await advanceTasks(run, deps())
  expect(run.tasks[1]?.phase).toBe('queued')
  expect(prompts).toHaveLength(0)
})

test('a queued task whose dependency failed becomes blocked-on-failure', async () => {
  const run = mkRun([
    mkTask({ task_id: 't1', phase: 'failed' }),
    mkTask({ task_id: 't2', depends_on: ['t1'] }),
  ])
  await advanceTasks(run, deps())
  expect(run.tasks[1]?.phase).toBe('blocked-on-failure')
})

test('a queued task whose dependency is escalated stays queued until it finishes', async () => {
  const run = mkRun([
    mkTask({ task_id: 't1', phase: 'escalated', escalated_from: 'implement' }),
    mkTask({ task_id: 't2', depends_on: ['t1'] }),
  ])
  await advanceTasks(run, deps())
  expect(run.tasks[1]?.phase).toBe('queued')

  const t1 = run.tasks[0] as Task
  t1.phase = 'done'
  t1.escalated_from = null
  await advanceTasks(run, deps())
  expect(run.tasks[1]?.phase).toBe('research')
})

test('an idle worker with a fresh PR advances to pr-review-intent', async () => {
  const run = mkRun([mkTask({ phase: 'implement', agent_status: 'idle', head_sha_at_entry: 'old' })])
  await advanceTasks(run, deps({
    prForBranch: async () => 42,
    prView: async () => ({ merged: false, mergedAtMs: null, headSha: 'new' }),
  }))
  expect(run.tasks[0]?.phase).toBe('pr-review-intent')
  expect(run.tasks[0]?.pr).toBe(42)
})

test('LIVELOCK: a task re-entering implement does not advance on the same sha', async () => {
  const run = mkRun([mkTask({ phase: 'implement', agent_status: 'idle', head_sha_at_entry: 'same', pr: 42 })])
  await advanceTasks(run, deps({
    prForBranch: async () => 42,
    prView: async () => ({ merged: false, mergedAtMs: null, headSha: 'same' }),
  }))
  expect(run.tasks[0]?.phase).toBe('implement')
})

test('a cleared task review advances to the second stage', async () => {
  const run = mkRun([mkTask({ phase: 'pr-review-intent' })])
  await advanceTasks(run, deps({
    verdictFor: async () => ({ verdict: 'CLEAR', blockers: 0, majors: 0 }),
  }))
  expect(run.tasks[0]?.phase).toBe('pr-review-quality')
})

test('orchestrator-owned task phases are not evaluated while the orchestrator is busy', async () => {
  const run = mkRun([mkTask({ phase: 'merge', pr: 42, phase_entered_at: 1_000 })])
  await advanceTasks(run, deps({
    liveIdle: async () => false,
    prView: async () => ({ merged: true, mergedAtMs: 2_000, headSha: 'x' }),
  }))
  expect(run.tasks[0]?.phase).toBe('merge')
})

test('a merged PR advances to close, and a closed issue to teardown', async () => {
  const run = mkRun([mkTask({ phase: 'merge', pr: 42, phase_entered_at: 1_000 })])
  await advanceTasks(run, deps({
    prView: async () => ({ merged: true, mergedAtMs: 2_000, headSha: 'x' }),
  }))
  expect(run.tasks[0]?.phase).toBe('close')

  run.tasks[0]!.phase_entered_at = 1_000
  await advanceTasks(run, deps({ issueView: async () => ({ closed: true, closedAtMs: 2_000 }) }))
  expect(run.tasks[0]?.phase).toBe('teardown')
})

test('an issue closed before the merge still lets close advance', async () => {
  const mergedAtMs = 10_000
  const view = {
    prView: async () => ({ merged: true, mergedAtMs, headSha: 'x' }),
    issueView: async () => ({ closed: true, closedAtMs: mergedAtMs - 30_000 }),
  }
  const run = mkRun([mkTask({ phase: 'merge', pr: 42, phase_entered_at: 1_000 })])

  await advanceTasks(run, deps(view))
  expect(run.tasks[0]?.phase).toBe('close')
  expect(run.tasks[0]?.issue_closed_at_entry).toBe(true)

  await advanceTasks(run, deps(view))
  expect(run.tasks[0]?.phase).toBe('teardown')
})

test('a rewind into merge rescues a close whose merge was never recorded', async () => {
  const mergedAtMs = 10_000
  const view = {
    prView: async () => ({ merged: true, mergedAtMs, headSha: 'x' }),
    issueView: async () => ({ closed: true, closedAtMs: mergedAtMs + 2_000 }),
  }
  const run = mkRun([mkTask({ phase: 'close', pr: 42, merged_at_ms: null })])
  await advanceTasks(run, deps(view))
  expect(run.tasks[0]?.phase).toBe('close')

  Object.assign(run.tasks[0]!, { phase: 'merge', phase_entered_at: Date.now() })
  await advanceTasks(run, deps(view))
  expect(run.tasks[0]?.phase).toBe('close')
  await advanceTasks(run, deps(view))
  expect(run.tasks[0]?.phase).toBe('teardown')
})

test('teardown removes the worktree and completes the task', async () => {
  const run = mkRun([mkTask({ phase: 'teardown' })])
  const removed: string[] = []
  await advanceTasks(run, deps({
    removeWorktree: async (ws: string) => { removed.push(ws); return 'removed' as const },
  }))
  expect(removed).toEqual(['w7'])
  expect(run.tasks[0]?.phase).toBe('done')
})

test('entering pr-review-intent yields that row\'s review prompt', async () => {
  const run = mkRun([mkTask({ phase: 'implement', agent_status: 'idle', head_sha_at_entry: 'old' })])
  const prompts = await advanceTasks(run, deps({
    prForBranch: async () => 42,
    prView: async () => ({ merged: false, mergedAtMs: null, headSha: 'new' }),
  }))
  expect(prompts.map((p) => p.text).join('\n')).toContain('pr-review-intent')
})

test('entering merge yields the merge prompt', async () => {
  const run = mkRun([mkTask({ phase: 'ci', pr: 42, ci: 'pass' })])
  const prompts = await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('merge')
  expect(prompts.map((p) => p.text).join('\n')).toContain('Ready to merge')
})

test('a red CI yields the ci-red prompt carrying the failure detail', async () => {
  const run = mkRun([mkTask({ phase: 'ci', pr: 42, ci: 'fail' })])
  const prompts = await advanceTasks(run, deps({
    ciDetail: async () => '- build (fail) https://example/run/1',
  }))
  expect(run.tasks[0]?.phase).toBe('implement')
  expect(prompts.map((p) => p.text).join('\n')).toContain('CI is red')
  expect(prompts.map((p) => p.text).join('\n')).toContain('build (fail)')
})

test('an escalated task yields the escalation prompt naming its task flag', async () => {
  const run = mkRun([mkTask({ phase: 'pr-review-quality', passes: { 'pr-review-quality': 1 } })])
  const prompts = await advanceTasks(run, deps({
    verdictFor: async () => ({ verdict: 'BLOCKER', blockers: 1, majors: 0 }),
  }))
  expect(run.tasks[0]?.phase).toBe('escalated')
  expect(prompts.map((p) => p.text).join('\n')).toContain('--task t1')
  expect(prompts.map((p) => p.text).join('\n')).toMatch(/rewind \S+ failed --task t1/)
})

test('a worker-owned phase addresses its prompt to the worker pane, not the orchestrator', async () => {
  const run = mkRun([mkTask({ phase: 'implement', agent_status: 'idle', head_sha_at_entry: 'old' })])
  const prompts = await advanceTasks(run, deps({
    prForBranch: async () => 42,
    prView: async () => ({ merged: false, mergedAtMs: null, headSha: 'new' }),
  }))
  expect(run.tasks[0]?.phase).toBe('pr-review-intent')
  expect(prompts[0]?.paneId).toBe('w7:p1')
})

test('an orchestrator-owned phase addresses its prompt to the orchestrator pane', async () => {
  const run = mkRun([mkTask({ phase: 'ci', pr: 42, ci: 'pass' })])
  const prompts = await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('merge')
  expect(prompts[0]?.paneId).toBe('w1:p1')
})

test('a dispatch prompt is addressed to the orchestrator — a queued task has no pane yet', async () => {
  const run = mkRun([mkTask({ pane_id: null })])
  const prompts = await advanceTasks(run, deps())
  expect(prompts[0]?.paneId).toBe('w1:p1')
})

test('a phase that advances nothing yields no prompt', async () => {
  const run = mkRun([mkTask({ phase: 'implement', agent_status: 'working' })])
  expect(await advanceTasks(run, deps())).toHaveLength(0)
})

test('close prompts only when the issue is still open', async () => {
  const open = mkRun([mkTask({ phase: 'close', pr: 42 })])
  expect(await promptForTaskPhase(open, open.tasks[0]!, deps(), 'merge')).not.toBe('')

  const closed = mkRun([mkTask({ phase: 'close', pr: 42, issue_closed_at_entry: true })])
  expect(await promptForTaskPhase(closed, closed.tasks[0]!, deps(), 'merge')).toBe('')
})

const designArtifacts = (): Task['artifacts'] => ({
  research: join('docs/superpowers/research', '2026-01-01-issue-1-research.md'),
  spec: join('docs/superpowers/specs', '2026-01-01-issue-1-design.md'),
  plan: join('docs/superpowers/plans', '2026-01-01-issue-1-plan.md'),
  verdicts: {},
})

function worktreeWith(relative: string): string {
  const dir = tempDir('hpipe-design-')
  mkdirSync(join(dir, dirname(relative)), { recursive: true })
  writeFileSync(join(dir, relative), 'findings\n')
  return dir
}

test('a design artifact row advances when its artifact is fresh in the worktree', async () => {
  const artifacts = designArtifacts()
  const dir = worktreeWith(artifacts.research as string)
  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: dir, artifacts,
  })])

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('spec')
})

test('a design artifact row does not advance on a file that predates phase entry', async () => {
  const artifacts = designArtifacts()
  const dir = worktreeWith(artifacts.research as string)
  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: Date.now() + 60_000, checkout_path: dir, artifacts,
  })])

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('research')
})

test('a design review row reads its verdict from the worktree', async () => {
  const run = mkRun([mkTask({ phase: 'spec-review', artifacts: designArtifacts() })])

  await advanceTasks(run, deps({
    verdictFor: async () => ({ verdict: 'CLEAR', blockers: 0, majors: 0 }),
  }))
  expect(run.tasks[0]?.phase).toBe('plan')
})

test('entering a design row delivers that row prompt to the worker pane', async () => {
  const artifacts = designArtifacts()
  const dir = worktreeWith(artifacts.research as string)
  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: dir, artifacts,
  })])

  const prompts = await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('spec')
  expect(prompts).toHaveLength(1)
  expect(prompts[0]?.paneId).toBe('w7:p1')
  expect(prompts[0]?.text.length).toBeGreaterThan(0)
})

test('a design row prompt names the artifact path its own predicate will check', async () => {
  for (const phase of ['research', 'spec', 'spec-review', 'plan', 'plan-review'] as const) {
    const run = mkRun([mkTask({
      phase, checkout_path: '/r/.worktrees/feat-x', artifacts: designArtifacts(),
    })])
    const task = run.tasks[0] as Task

    const watched = absoluteArtifactPath(run, task)
    expect(watched).not.toBeNull()
    expect(await promptForTaskPhase(run, task, deps(), 'research')).toContain(watched as string)
  }
})

test('a misfiled artifact is adopted from the branch and recorded on the task', async () => {
  const worktree = repoWithWorktree([
    'docs/superpowers/plans/old-a.md',
    'docs/superpowers/specs/old-b.md',
    'docs/superpowers/reviews/old-c.md',
  ])
  commitIn(worktree, 'docs/superpowers/notes/misfiled.md', 'the note\n')

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: worktree, artifacts: designArtifacts(),
  })])

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('spec')
  expect(run.tasks[0]?.artifacts.research).toBe('docs/superpowers/notes/misfiled.md')
})

test('adoption survives pre-existing docs being touched after the worker commits', async () => {
  const worktree = repoWithWorktree([
    'docs/superpowers/plans/old-a.md',
    'docs/superpowers/specs/old-b.md',
  ])
  commitIn(worktree, 'docs/superpowers/notes/misfiled.md', 'the note\n')
  const now = new Date()
  utimesSync(join(worktree, 'docs/superpowers/plans/old-a.md'), now, now)
  utimesSync(join(worktree, 'docs/superpowers/specs/old-b.md'), now, now)

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: worktree, artifacts: designArtifacts(),
  })])

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('spec')
  expect(run.tasks[0]?.artifacts.research).toBe('docs/superpowers/notes/misfiled.md')
})

test('the adoption scan does not run while the worker is still working', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/misfiled.md', 'the note\n')

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: worktree, artifacts: designArtifacts(),
  })])

  await advanceTasks(run, deps({ liveIdle: async () => false }))
  expect(run.tasks[0]?.phase).toBe('research')
  expect(run.tasks[0]?.artifacts.research).toBe(designArtifacts().research)
})

test('a branch with no commits past the base adopts nothing', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: worktree, artifacts: designArtifacts(),
  })])

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('research')
  expect(run.tasks[0]?.artifacts.research).toBe(designArtifacts().research)
})

test('in spec, the recorded research note is not re-adopted and the spec is', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/the-research.md', 'research\n')
  commitIn(worktree, 'docs/superpowers/notes/the-spec.md', 'spec\n')

  const artifacts = designArtifacts()
  artifacts.research = 'docs/superpowers/notes/the-research.md'
  const run = mkRun([mkTask({
    phase: 'spec', phase_entered_at: 0, checkout_path: worktree, artifacts,
  })])

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('spec-review')
  expect(run.tasks[0]?.artifacts.spec).toBe('docs/superpowers/notes/the-spec.md')
  expect(run.tasks[0]?.artifacts.research).toBe('docs/superpowers/notes/the-research.md')
})

test('a present-but-stale canonical artifact is never replaced by adoption', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  const artifacts = designArtifacts()
  mkdirSync(join(worktree, dirname(artifacts.spec as string)), { recursive: true })
  writeFileSync(join(worktree, artifacts.spec as string), 'the real spec\n')
  commitIn(worktree, 'docs/superpowers/notes/stray.md', 'a stray doc\n')

  const run = mkRun([mkTask({
    phase: 'spec', phase_entered_at: Date.now() + 60_000, checkout_path: worktree, artifacts,
  })])

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('spec')
  expect(run.tasks[0]?.artifacts.spec).toBe(artifacts.spec)
})

test('two candidates are ambiguous, nothing is adopted, and it is logged once', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/one.md', 'first\n')
  commitIn(worktree, 'docs/superpowers/notes/two.md', 'second\n')

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: worktree, artifacts: designArtifacts(),
  })])
  const ambiguityLog = new Set<string>()

  const seen: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { seen.push(args.join(' ')) }
  try {
    await advanceTasks(run, deps({ ambiguityLog }))
    await advanceTasks(run, deps({ ambiguityLog }))
    await advanceTasks(run, deps({ ambiguityLog }))
  } finally {
    console.error = original
  }

  expect(run.tasks[0]?.phase).toBe('research')
  expect(run.tasks[0]?.artifacts.research).toBe(designArtifacts().research)
  expect(seen.filter((line) => line.includes('ambiguous'))).toHaveLength(1)
})

test('an idle worker with two candidates records the missing artifact and both candidates', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/one.md', 'first\n')
  commitIn(worktree, 'docs/superpowers/notes/two.md', 'second\n')

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 5, checkout_path: worktree, artifacts: designArtifacts(),
  })])
  const original = console.error
  console.error = () => {}
  try {
    await advanceTasks(run, deps())
  } finally {
    console.error = original
  }

  expect(run.tasks[0]?.artifact_missing).toEqual({
    at: 5,
    path: join(worktree, designArtifacts().research as string),
    candidates: ['docs/superpowers/notes/one.md', 'docs/superpowers/notes/two.md'],
  })
})

test('an idle worker whose branch added nothing records the missing artifact with no candidates', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 5, checkout_path: worktree, artifacts: designArtifacts(),
  })])
  await advanceTasks(run, deps())

  expect(run.tasks[0]?.artifact_missing).toEqual({
    at: 5, path: join(worktree, designArtifacts().research as string), candidates: [],
  })
})

test('a working worker clears a missing-artifact record instead of reporting it', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 5, checkout_path: worktree, artifacts: designArtifacts(),
    artifact_missing: { at: 5, path: '/somewhere', candidates: [] },
  })])
  await advanceTasks(run, deps({ liveIdle: async () => false }))

  expect(run.tasks[0]?.artifact_missing).toBeUndefined()
})

test('the missing-artifact record clears once the artifact appears', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  const artifacts = designArtifacts()

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 5, checkout_path: worktree, artifacts,
  })])
  await advanceTasks(run, deps())
  expect(run.tasks[0]?.artifact_missing).toBeDefined()

  mkdirSync(join(worktree, dirname(artifacts.research as string)), { recursive: true })
  writeFileSync(join(worktree, artifacts.research as string), 'the note\n')
  await advanceTasks(run, deps())

  expect(run.tasks[0]?.phase).toBe('spec')
  expect(run.tasks[0]?.artifact_missing).toBeUndefined()
})

test('a present-but-stale artifact is not reported as missing', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  const artifacts = designArtifacts()
  mkdirSync(join(worktree, dirname(artifacts.spec as string)), { recursive: true })
  writeFileSync(join(worktree, artifacts.spec as string), 'the previous pass\n')

  const run = mkRun([mkTask({
    phase: 'spec', phase_entered_at: Date.now() + 60_000, checkout_path: worktree, artifacts,
  })])
  await advanceTasks(run, deps())

  expect(run.tasks[0]?.phase).toBe('spec')
  expect(run.tasks[0]?.artifact_missing).toBeUndefined()
})

test('with no checkout the scan never falls back to the main checkout', async () => {
  const mainCheckout = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(mainCheckout, 'docs/superpowers/notes/somebody-elses.md', 'not ours\n')

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: null, artifacts: designArtifacts(),
  })])
  run.repo_root = mainCheckout

  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('research')
  expect(run.tasks[0]?.artifacts.research).toBe(designArtifacts().research)
})

test('one shared dedup set still reports the same task id in two live runs', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/one.md', 'first\n')
  commitIn(worktree, 'docs/superpowers/notes/two.md', 'second\n')

  const twin = () => mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: worktree, artifacts: designArtifacts(),
  })])
  const [first, second] = [twin(), twin()]
  const ambiguityLog = new Set<string>()

  const seen: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { seen.push(args.join(' ')) }
  try {
    await advanceTasks(first, deps({ ambiguityLog }))
    await advanceTasks(second, deps({ ambiguityLog }))
  } finally {
    console.error = original
  }

  expect(first.run_id).not.toBe(second.run_id)
  expect(seen.filter((line) => line.includes('ambiguous'))).toHaveLength(2)
})

test('a review row reserves its verdict path before the prompt names it', async () => {
  const run = mkRun([mkTask({ phase: 'spec-review', artifacts: designArtifacts() })])
  const task = run.tasks[0] as Task

  const text = await promptForTaskPhase(run, task, deps(), 'spec')
  const watched = absoluteArtifactPath(run, task)

  expect(task.verdict_seq?.['spec-review']).toBe(1)
  expect(watched)
    .toBe('/r/.worktrees/feat-x/docs/superpowers/reviews/issue-1-spec-review-0.md')
  expect(text).toContain(watched as string)
})

test('a row that is not a review reserves nothing', async () => {
  const run = mkRun([mkTask({ phase: 'spec', artifacts: designArtifacts() })])
  const task = run.tasks[0] as Task

  await promptForTaskPhase(run, task, deps(), 'research')

  expect(task.verdict_seq).toBeUndefined()
  expect(task.artifacts.verdicts).toEqual({})
})

test('re-entering pr-review-intent after a quality blocker does not reuse the first review', async () => {
  // `pr-review-quality`'s BLOCKER bumps ITS counter and sends the task to
  // `implement`; `implement` clears back to `pr-review-intent`, whose own counter
  // never moved — so before #26 the second intent review was handed the first
  // one's filename, with no rewind involved.
  const run = mkRun([mkTask({ phase: 'pr-review-intent', pr: 7, artifacts: designArtifacts() })])
  const task = run.tasks[0] as Task

  await promptForTaskPhase(run, task, deps(), 'implement')
  const first = absoluteArtifactPath(run, task)

  task.passes = { 'pr-review-quality': 1 }
  await promptForTaskPhase(run, task, deps(), 'implement')
  const second = absoluteArtifactPath(run, task)

  expect(counterFor(task, 'pr-review-intent')).toBe(0)
  expect(first).toContain('issue-1-pr-review-intent-0.md')
  expect(second).toContain('issue-1-pr-review-intent-1.md')
  expect(second).not.toBe(first)
})

test('the dispatch prompt names the repo bootstrap above the blank line', async () => {
  const repo = tempDir('hpipe-bootrepo-')
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'pipeline-bootstrap'), '#!/bin/sh\ntrue\n')
  chmodSync(join(repo, '.claude', 'pipeline-bootstrap'), 0o755)

  const run = mkRun([mkTask({})])
  run.repo_root = repo
  const prompts = await advanceTasks(run, deps())

  const text = prompts[0]!.text
  expect(text).toContain('bootstrap: .claude/pipeline-bootstrap')

  // The blank-line split prompts/dispatch.md:26-30 documents: everything before
  // the first blank line is the orchestrator's, everything after is the worker's.
  const head = text.split('\n\n')[0]!
  expect(head).toContain('bootstrap: .claude/pipeline-bootstrap')
  expect(text.split('\n\n').slice(1).join('\n\n')).toStartWith('# feat/x — issue #1')
})

const dirtyTree = (paths: string[] | null) => {
  const calls: string[] = []
  return {
    calls,
    uncommittedPaths: async (checkout: string) => { calls.push(checkout); return paths },
  }
}

test('an idle worker in a code row records its uncommitted work against the phase entry', async () => {
  const git = dirtyTree(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])
  const run = mkRun([mkTask({ phase: 'implement', phase_entered_at: 5 })])
  await advanceTasks(run, deps({ uncommittedPaths: git.uncommittedPaths }))
  expect(git.calls).toEqual(['/r/.worktrees/feat-x'])
  expect(run.tasks[0]?.uncommitted_work).toEqual({
    at: 5, count: 4, sample: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  })
})

test('an idle spell is inspected once, not on every tick', async () => {
  for (const paths of [['src/a.ts'], []]) {
    const git = dirtyTree(paths)
    const run = mkRun([mkTask({ phase: 'pr-review-quality', phase_entered_at: 5 })])
    await advanceTasks(run, deps({ uncommittedPaths: git.uncommittedPaths }))
    await advanceTasks(run, deps({ uncommittedPaths: git.uncommittedPaths }))
    expect(git.calls, `after ${paths.length} dirty paths`).toHaveLength(1)
  }
})

test('a busy worker drops the record, so its next idle spell is inspected afresh', async () => {
  const git = dirtyTree(['src/a.ts'])
  const run = mkRun([mkTask({ phase: 'implement', phase_entered_at: 5,
                              uncommitted_work: { at: 5, count: 1, sample: ['src/a.ts'] } })])
  await advanceTasks(run, deps({ liveIdle: async () => false, uncommittedPaths: git.uncommittedPaths }))
  expect(run.tasks[0]?.uncommitted_work).toBeUndefined()
  expect(git.calls).toHaveLength(0)
})

test('design rows record nothing', async () => {
  const designGit = dirtyTree(['docs/x.md'])
  const design = mkRun([mkTask({ phase: 'spec', phase_entered_at: 5 })])
  await advanceTasks(design, deps({ uncommittedPaths: designGit.uncommittedPaths }))
  expect(designGit.calls).toHaveLength(0)
  expect(design.tasks[0]?.uncommitted_work).toBeUndefined()
})

test('an unreadable checkout reports nothing and is retried only on the next idle spell', async () => {
  const brokenGit = dirtyTree(null)
  const run = mkRun([mkTask({ phase: 'implement', phase_entered_at: 5 })])
  await advanceTasks(run, deps({ uncommittedPaths: brokenGit.uncommittedPaths }))
  await advanceTasks(run, deps({ uncommittedPaths: brokenGit.uncommittedPaths }))
  expect(brokenGit.calls).toHaveLength(1)
  expect(run.tasks[0]?.uncommitted_work?.count).toBe(0)

  await advanceTasks(run, deps({ liveIdle: async () => false, uncommittedPaths: brokenGit.uncommittedPaths }))
  await advanceTasks(run, deps({ uncommittedPaths: brokenGit.uncommittedPaths }))
  expect(brokenGit.calls).toHaveLength(2)
})

test('the dispatch line names the base the supervisor just refreshed, fetched once per tick', async () => {
  const calls: string[] = []
  const run = mkRun([mkTask({ task_id: 't1' }), mkTask({ task_id: 't2', branch: 'feat/y' })])
  const prompts = await advanceTasks(run, deps({
    freshDispatchBase: async (repoRoot: string) => { calls.push(repoRoot); return 'origin/trunk' },
  }))

  expect(prompts).toHaveLength(2)
  for (const prompt of prompts) {
    expect(prompt.text.split('\n')[0]).toContain('worktree create --cwd /r --base origin/trunk')
  }
  expect(calls).toEqual(['/r'])
})

test('no fetch runs on a tick that dispatches nothing', async () => {
  const calls: string[] = []
  const run = mkRun([mkTask({ phase: 'implement' })])
  await advanceTasks(run, deps({
    freshDispatchBase: async (repoRoot: string) => { calls.push(repoRoot); return 'origin/main' },
  }))
  expect(calls).toEqual([])
})

test('a repo declaring no bootstrap still says so in the dispatch prompt', async () => {
  const run = mkRun([mkTask({})])   // mkRun uses repoRoot '/r', which does not exist
  const prompts = await advanceTasks(run, deps())
  expect(prompts[0]!.text).toContain('bootstrap: none')
})

test('a teardown whose save lost to a CLI write stays done and its dependent still dispatches', async () => {
  // The #67 review's reproduction: without the re-apply, tick 2 finds the
  // workspace gone, orphans t1, and fails t2 terminally into blocked-on-failure.
  const stateDir = tempDir('tasks-ledger-')
  const run = mkRun([
    mkTask({ task_id: 't1', phase: 'teardown', workspace_id: 'w7' }),
    mkTask({ task_id: 't2', phase: 'queued', depends_on: ['t1'], workspace_id: null, pane_id: null }),
  ])
  await saveRun(stateDir, run)
  const tickCopy = (await loadRun(stateDir, run.session, run.run_id))!

  const effects: RunEffect[] = []
  const removed: string[] = []
  await advanceTasks(tickCopy, deps({
    removeWorktree: async (ws) => { removed.push(ws); return 'removed' as const },
    effects,
  }))

  const cliCopy = (await loadRun(stateDir, run.session, run.run_id))!
  cliCopy.tasks[1]!.notes = 'edited by a CLI command'
  await saveRun(stateDir, cliCopy)

  expect(await saveOrReapply(stateDir, tickCopy, effects)).toBe('reapplied')

  const nextTick = (await loadRun(stateDir, run.session, run.run_id))!
  expect(nextTick.tasks[0]?.phase).toBe('done')
  expect(nextTick.tasks[1]?.notes).toBe('edited by a CLI command')
  await advanceTasks(nextTick, deps({
    removeWorktree: async (ws) => { removed.push(ws); return 'gone' as const },
  }))
  expect(removed).toEqual(['w7'])
  expect(nextTick.tasks.map((t) => t.phase)).toEqual(['done', 'research'])
})

test('a second teardown of a workspace herdr no longer knows completes the task', async () => {
  // Also the supervisor-crash-between-removal-and-save case.
  const run = mkRun([mkTask({ task_id: 't1', phase: 'teardown', checkout_path: '/nonexistent/wt' })])
  await advanceTasks(run, deps({ removeWorktree: async () => 'gone' as const }))
  expect(run.tasks[0]?.phase).toBe('done')
})

test('a vanished workspace whose checkout is still on disk is orphaned, not done', async () => {
  const checkout = tempDir('tasks-checkout-')
  const run = mkRun([mkTask({ task_id: 't1', phase: 'teardown', checkout_path: checkout })])
  await advanceTasks(run, deps({ removeWorktree: async () => 'gone' as const }))
  expect(run.tasks[0]?.phase).toBe('orphaned')
})

test('a task the gate opens is awaiting its brief — #89', async () => {
  const run = mkRun([mkTask({ task_id: 't1', phase: 'queued' })])
  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('research')
  expect(run.tasks[0]?.awaiting_brief).toBe(true)
})

test('an idle worker that was never briefed is not recorded as missing its artifact — #89', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 5, checkout_path: worktree, artifacts: designArtifacts(),
    awaiting_brief: true,
  })])
  await advanceTasks(run, deps())
  expect(run.tasks[0]?.artifact_missing).toBeUndefined()
  expect(run.tasks[0]?.awaiting_brief).toBe(true)
})

test('a not-idle read is not proof of a brief — it may be a failed agent get — #89', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 5, checkout_path: worktree, artifacts: designArtifacts(),
    awaiting_brief: true,
  })])
  await advanceTasks(run, deps({ liveIdle: async () => false }))
  expect(run.tasks[0]?.awaiting_brief).toBe(true)
})

test('leaving the briefed phase drops the awaiting-brief mark — #89', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  const artifacts = designArtifacts()
  mkdirSync(join(worktree, dirname(artifacts.research as string)), { recursive: true })
  writeFileSync(join(worktree, artifacts.research as string), 'the note\n')
  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 5, checkout_path: worktree, artifacts, awaiting_brief: true,
  })])
  await advanceTasks(run, deps())
  expect(run.tasks[0]?.phase).toBe('spec')
  expect(run.tasks[0]?.awaiting_brief).toBeUndefined()
})
