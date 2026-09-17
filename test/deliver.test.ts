import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  absoluteArtifactPath, adoptableArtifacts, artifactPathFor, buildDigest, deliveriesFor,
  shouldRetry, taskSignalsFor,
} from '../src/supervisor/deliver'
import { cleanupFixtures, commitIn, git, repoWithWorktree, tempDir } from './helpers/git-worktree'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'implement', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function mkRun(): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  return run
}

test('the digest carries the run id, the event lines, and the next prompt', () => {
  const text = buildDigest({
    run: mkRun(),
    eventLines: ['- feat/x (#1, t1) done, PR #412 open'],
    phaseNote: ' → pr-review-intent',
    nextPrompt: 'REVIEW THIS',
  })
  expect(text).toContain('[pipeline] run')
  expect(text).toContain('1 events')
  expect(text).toContain('feat/x (#1, t1) done')
  expect(text).toContain('REVIEW THIS')
})

test('a digest with no phase change still delivers the events', () => {
  const text = buildDigest({
    run: mkRun(), eventLines: ['- feat/x (#1, t1) blocked'], phaseNote: '', nextPrompt: '',
  })
  expect(text).toContain('blocked')
})

test('three prompts for three panes produce three deliveries', () => {
  const run = mkRun()
  const out = deliveriesFor([
    { paneId: 'w1:p1', run, text: 'orchestrator prompt', isOrchestrator: true, events: ['e1'] },
    { paneId: 'w7:p1', run, text: 'worker 1 prompt', isOrchestrator: false, events: [] },
    { paneId: 'w8:p1', run, text: 'worker 2 prompt', isOrchestrator: false, events: [] },
  ])
  expect(out).toHaveLength(3)
  expect(out.map((d) => d.paneId).sort()).toEqual(['w1:p1', 'w7:p1', 'w8:p1'])
})

test('a worker delivery carries no run digest header', () => {
  const run = mkRun()
  const out = deliveriesFor([
    { paneId: 'w7:p1', run, text: 'worker prompt', isOrchestrator: false, events: ['e1'] },
  ])
  expect(out[0]?.text).toBe('worker prompt')
  expect(out[0]?.text).not.toContain('[pipeline] run')
})

test('the orchestrator delivery carries the header and its events', () => {
  const run = mkRun()
  const out = deliveriesFor([
    { paneId: 'w1:p1', run, text: 'do the thing', isOrchestrator: true, events: ['e1', 'e2'] },
  ])
  expect(out[0]?.text).toContain('[pipeline] run')
  expect(out[0]?.text).toContain('2 events')
  expect(out[0]?.text).toContain('do the thing')
})

test('two prompts for the SAME pane are joined, not dropped', () => {
  const run = mkRun()
  const out = deliveriesFor([
    { paneId: 'w1:p1', run, text: 'first', isOrchestrator: true, events: [] },
    { paneId: 'w1:p1', run, text: 'second', isOrchestrator: true, events: [] },
  ])
  expect(out).toHaveLength(1)
  expect(out[0]?.text).toContain('first')
  expect(out[0]?.text).toContain('second')
})

test('no prompt with content is ever dropped', () => {
  const run = mkRun()
  const texts = ['alpha prompt', 'bravo prompt', 'charlie prompt', 'delta prompt', 'echo prompt']
  const out = deliveriesFor([
    { paneId: 'w1:p1', run, text: texts[0] as string, isOrchestrator: true, events: ['e1'] },
    { paneId: 'w7:p1', run, text: texts[1] as string, isOrchestrator: false, events: [] },
    { paneId: 'w1:p1', run, text: texts[2] as string, isOrchestrator: true, events: [] },
    { paneId: 'w8:p1', run, text: texts[3] as string, isOrchestrator: false, events: [] },
    { paneId: 'w9:p1', run, text: texts[4] as string, isOrchestrator: false, events: [] },
  ])
  for (const text of texts) {
    expect(out.filter((d) => d.text.includes(text))).toHaveLength(1)
  }
})

test('agent_blocked is retryable below the cap', () => {
  expect(shouldRetry('agent_blocked', 1, 5)).toBe(true)
})

test('retries stop at the cap', () => {
  expect(shouldRetry('agent_blocked', 5, 5)).toBe(false)
})

test('an unknown pane is retryable — it may be restoring', () => {
  expect(shouldRetry('pane_not_found', 1, 5)).toBe(true)
})

test('a blocked worker line inlines its pane tail', () => {
  const run = mkRun()
  run.tasks.push(mkTask({ agent_status: 'blocked' }))
  const text = buildDigest({
    run,
    eventLines: ['- feat/x (#1, t1) blocked', '    "Do you want to proceed?"'],
    phaseNote: '', nextPrompt: '',
  })
  expect(text).toContain('Do you want to proceed?')
})

import { advanceRun, isAgentReady } from '../src/lib/machine'

test('an agent that finished its turn is ready, whether idle or done', () => {
  // herdr reports `done` for "idle and not yet seen". An orchestrator driven by
  // this plugin is never seen by a human, so `done` is its normal resting state
  // — treating only `idle` as ready stalls every run at its first phase.
  expect(isAgentReady('idle')).toBe(true)
  expect(isAgentReady('done')).toBe(true)
})

test('an agent still working or blocked is not ready', () => {
  expect(isAgentReady('working')).toBe(false)
  expect(isAgentReady('blocked')).toBe(false)
  expect(isAgentReady('unknown')).toBe(false)
})

test('a review path is keyed by the phase counter, so a re-review is a new file', () => {
  const run = mkRun()
  run.phase = 'branch-review'
  const first = artifactPathFor(run, null)
  run.passes['branch-review'] = 1
  expect(artifactPathFor(run, null)).not.toBe(first)
})

test('a seeded verdict path wins over the default', () => {
  const run = mkRun()
  run.phase = 'branch-review'
  run.artifacts.verdicts['branch-review-0'] = 'docs/superpowers/reviews/custom.md'
  expect(artifactPathFor(run, null)).toBe('docs/superpowers/reviews/custom.md')
})

test('an escalated task is settled, so a run holding one still leaves execute', () => {
  const run = mkRun()
  run.phase = 'execute'
  run.intake_closed = true
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'escalated' }),
    mkTask({ task_id: 't2', phase: 'done' }),
  ]
  const advanced = advanceRun(run, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    ...taskSignalsFor(run),
  })
  expect(advanced?.phase).toBe('branch-review')
})

test('a task still in flight leaves the run in execute', () => {
  const run = mkRun()
  run.phase = 'execute'
  run.intake_closed = true
  run.tasks = [mkTask({ task_id: 't1', phase: 'implement' }), mkTask({ task_id: 't2', phase: 'done' })]
  expect(advanceRun(run, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    ...taskSignalsFor(run),
  })).toBeNull()
})

test('the registration and adoption signals are the newest of each, or null', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', registered_at: 1_000, adopted_at: null }),
    mkTask({ task_id: 't2', registered_at: 3_000, adopted_at: 2_000 }),
  ]
  expect(taskSignalsFor(run).newestRegisteredAt).toBe(3_000)
  expect(taskSignalsFor(run).newestAdoptedAt).toBe(2_000)
  expect(taskSignalsFor(mkRun()).newestRegisteredAt).toBeNull()
  expect(taskSignalsFor(mkRun()).newestAdoptedAt).toBeNull()
})

test('the digest keeps evaluateRun\'s transition note, not just the current phase', () => {
  const run = mkRun()
  const out = deliveriesFor([
    {
      paneId: 'w1:p1', run, text: 'review the branch', isOrchestrator: true,
      events: [], phaseNote: ' → branch-review (from execute)',
    },
  ])
  expect(out[0]?.text).toContain('(from execute)')
})

test('a task artifact path resolves against the worktree, not repo_root', () => {
  const run = mkRun()
  const task = mkTask({ phase: 'spec', checkout_path: '/r/.worktrees/feat-x' })
  task.artifacts.spec = 'docs/superpowers/specs/2026-09-15-issue-210-design.md'
  run.tasks = [task]
  expect(absoluteArtifactPath(run, task))
    .toBe('/r/.worktrees/feat-x/docs/superpowers/specs/2026-09-15-issue-210-design.md')
})

test('a run artifact path resolves against repo_root', () => {
  const run = mkRun()
  run.phase = 'branch-review'
  expect(absoluteArtifactPath(run, null)).toStartWith('/r/docs/superpowers/reviews/')
})

test('a verdict row reads the verdict slot keyed by phase and counter', () => {
  const run = mkRun()
  const task = mkTask({ phase: 'spec-review', checkout_path: '/w', passes: { 'spec-review': 1 } })
  run.tasks = [task]
  expect(absoluteArtifactPath(run, task)).toContain('spec-review-1')
})

test('each artifact row reads its own slot, not a verdict path', () => {
  const run = mkRun()
  const seeded = {
    research: 'docs/superpowers/research/note.md',
    spec: 'docs/superpowers/specs/design.md',
    plan: 'docs/superpowers/plans/plan.md',
    verdicts: { 'research-0': 'wrong.md', 'spec-0': 'wrong.md', 'plan-0': 'wrong.md' },
  }
  for (const phase of ['research', 'spec', 'plan'] as const) {
    const task = mkTask({ phase, checkout_path: '/w', artifacts: { ...seeded, verdicts: {} } })
    expect(absoluteArtifactPath(run, task)).toBe(`/w/${seeded[phase]}`)
  }
})

test('a task with no checkout path falls back to repo_root', () => {
  const run = mkRun()
  const task = mkTask({ phase: 'spec', checkout_path: null })
  task.artifacts.spec = 'docs/superpowers/specs/design.md'
  expect(absoluteArtifactPath(run, task)).toBe('/r/docs/superpowers/specs/design.md')
})

afterEach(cleanupFixtures)

test('adoptableArtifacts returns docs this branch added, not what the worktree checked out', async () => {
  const worktree = repoWithWorktree([
    'docs/superpowers/plans/old-a.md',
    'docs/superpowers/specs/old-b.md',
  ])
  commitIn(worktree, 'docs/superpowers/notes/misfiled.md', 'the note\n')

  expect(await adoptableArtifacts(worktree, new Set())).toEqual([
    'docs/superpowers/notes/misfiled.md',
  ])
})

test('adoptableArtifacts yields nothing without a checkout', async () => {
  expect(await adoptableArtifacts(null, new Set())).toEqual([])
})

test('adoptableArtifacts yields nothing outside a git repo', async () => {
  expect(await adoptableArtifacts(tempDir('hpipe-nogit-'), new Set())).toEqual([])
})

test('adoptableArtifacts yields nothing when the base ref does not resolve', async () => {
  const noMain = tempDir('hpipe-nomain-')
  git(['init', '-q', '--initial-branch=trunk', '.'], noMain)
  git(['config', 'user.email', 'test@example.com'], noMain)
  git(['config', 'user.name', 'Test'], noMain)
  writeFileSync(join(noMain, 'README.md'), 'x\n')
  git(['add', '-A'], noMain)
  git(['commit', '-qm', 'base'], noMain)

  expect(await adoptableArtifacts(noMain, new Set())).toEqual([])
})

test('adoptableArtifacts excludes review verdicts, which are added on the branch too', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/reviews/issue-1-spec-review-0.md', 'VERDICT: CLEAR\n')
  commitIn(worktree, 'docs/superpowers/notes/misfiled.md', 'the note\n')

  expect(await adoptableArtifacts(worktree, new Set())).toEqual([
    'docs/superpowers/notes/misfiled.md',
  ])
})

test('adoptableArtifacts excludes paths already recorded on the task', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/research-note.md', 'research\n')
  commitIn(worktree, 'docs/superpowers/notes/the-spec.md', 'spec\n')

  const claimed = new Set(['docs/superpowers/notes/research-note.md'])
  expect(await adoptableArtifacts(worktree, claimed)).toEqual([
    'docs/superpowers/notes/the-spec.md',
  ])
})

test('a moved doc is a rename even when the repo disables rename detection', async () => {
  const worktree = repoWithWorktree(
    ['docs/superpowers/notes/original.md'],
    [['diff.renames', 'false']],
  )
  git(['mv', 'docs/superpowers/notes/original.md', 'docs/superpowers/notes/renamed.md'], worktree)
  git(['commit', '-qm', 'move it'], worktree)

  expect(await adoptableArtifacts(worktree, new Set())).toEqual([])
})

test('a non-ASCII candidate path comes back raw, not C-quoted', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/café-señor.md', 'the note\n')

  expect(await adoptableArtifacts(worktree, new Set())).toEqual([
    'docs/superpowers/notes/café-señor.md',
  ])
})
