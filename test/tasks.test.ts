import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { advanceTasks, promptForTaskPhase } from '../src/supervisor/tasks'
import { absoluteArtifactPath } from '../src/supervisor/deliver'
import { newRun } from '../src/lib/ledger'
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
  removeWorktree: async () => true,
  ciDetail: async () => '',
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

test('teardown removes the worktree and completes the task', async () => {
  const run = mkRun([mkTask({ phase: 'teardown' })])
  const removed: string[] = []
  await advanceTasks(run, deps({
    removeWorktree: async (ws: string) => { removed.push(ws); return true },
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

test('the supervisor default dedup set is what production actually uses', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/one.md', 'first\n')
  commitIn(worktree, 'docs/superpowers/notes/two.md', 'second\n')

  // No `ambiguityLog` in deps, exactly as src/supervisor/main.ts builds them, so
  // this is the only test that exercises the module-level default. Keyed on a
  // task_id and phase_entered_at no other test uses, because that set is
  // process-lifetime and shared across this file.
  const run = mkRun([mkTask({
    task_id: 'tdefault', phase: 'research', phase_entered_at: 7,
    checkout_path: worktree, artifacts: designArtifacts(),
  })])

  const seen: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { seen.push(args.join(' ')) }
  try {
    await advanceTasks(run, deps())
    await advanceTasks(run, deps())
  } finally {
    console.error = original
  }

  expect(run.tasks[0]?.phase).toBe('research')
  expect(seen.filter((line) => line.includes('ambiguous'))).toHaveLength(1)
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
