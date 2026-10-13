import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDecision } from '../src/lib/decisions'
import { newRun, withBatch } from '../src/lib/ledger'
import { IMPLEMENT_MODEL, PLAN_REVIEW_EFFORT, REVIEW_EFFORT, WORKER_EFFORT } from '../src/lib/models'
import { TIERS } from '../src/lib/phases'
import { effortSummary, phaseLoop, reviewEfforts, taskTiers, tierPromptVars } from '../src/lib/tier-prompt'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import { renderWorkerPrompt } from '../src/lib/worker-prompt'
import { renderRunPhasePrompt } from '../src/supervisor/deliver'
import { announceDecisions, renderTaskPhasePrompt } from '../src/supervisor/tasks'
import { cleanupFixtures, tempDir } from './helpers/git-worktree'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

afterEach(cleanupFixtures)

function mkTask(over: Partial<Task> = {}): Task {
  return {
    task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core',
    depends_on: [], files: [], keep_worktree: false,
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase: 'research', phase_entered_at: 0, escalated_from: null,
    head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: '/r/.worktrees/feat-x', registered_at: 0, adopted_at: 0,
    artifacts: { research: 'docs/r.md', spec: 'docs/s.md', plan: 'docs/p.md', verdicts: {} },
    merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    ...over,
  }
}

const PER_TASK = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })

const HEAD = [
  '1. `research` → `docs/r.md`',
  '2. `spec` → `docs/s.md`',
  '3. `spec-review` — you dispatch the reviewer',
  '4. `plan` → `docs/p.md`',
]

test('only implement\'s coding subagent is pinned, to sonnet', () => {
  expect(IMPLEMENT_MODEL).toBe('sonnet')
})

test('workers and reviewers run at an effort set by tier, never at the user default', () => {
  expect(WORKER_EFFORT).toEqual({ light: 'medium', standard: 'high', heavy: 'xhigh' })
  expect(REVIEW_EFFORT).toEqual({ light: 'high', standard: 'high', heavy: 'xhigh' })
})

// Its BLOCKER/MAJOR findings were mostly errors the implementer's own red/green
// loop hits minutes later, so a standard plan review no longer pays for `high`.
test('a plan review runs at medium on standard and at xhigh on heavy', () => {
  expect(PLAN_REVIEW_EFFORT).toEqual({ light: 'medium', standard: 'medium', heavy: 'xhigh' })
})

test('review_effort is the effort of the review the task is in', () => {
  const effortIn = (phase: TaskPhase, tier: 'light' | 'standard' | 'heavy') =>
    tierPromptVars(PER_TASK, mkTask({ phase, tier })).review_effort
  expect(effortIn('spec-review', 'standard')).toBe('high')
  expect(effortIn('plan-review', 'standard')).toBe('medium')
  expect(effortIn('pr-review', 'standard')).toBe('high')
  expect(effortIn('plan-review', 'heavy')).toBe('xhigh')
  expect(effortIn('pr-review', 'light')).toBe('high')
})

test('the review efforts name a review that runs at another effort than the rest', () => {
  expect(reviewEfforts('light')).toBe('high')
  expect(reviewEfforts('standard')).toBe('high (plan-review medium)')
  expect(reviewEfforts('heavy')).toBe('xhigh')
  expect(effortSummary(mkTask({ tier: 'standard' }))).toBe('worker high, reviews high (plan-review medium)')
  expect(effortSummary(mkTask({ tier: 'light' }))).toBe('worker medium, reviews high')
})

test('the light loop skips plan-review and runs one combined PR review', () => {
  expect(phaseLoop(PER_TASK, mkTask({ tier: 'light' }))).toBe([
    ...HEAD,
    '5. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '6. `pr-review` — one review of the PR, intent then quality',
  ].join('\n'))
})

test('the standard loop keeps plan-review and the combined PR review', () => {
  expect(phaseLoop(PER_TASK, mkTask({ tier: 'standard' }))).toBe([
    ...HEAD,
    '5. `plan-review` — you dispatch the reviewer again',
    '6. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '7. `pr-review` — one review of the PR, intent then quality',
  ].join('\n'))
})

test('the heavy loop runs the same combined PR review as every other tier', () => {
  expect(phaseLoop(PER_TASK, mkTask())).toBe([
    ...HEAD,
    '5. `plan-review` — you dispatch the reviewer again',
    '6. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '7. `pr-review` — one review of the PR, intent then quality',
  ].join('\n'))
})

test('a single-PR loop ends implement with hpipe submit and gains the sync step', () => {
  const singlePr = withBatch(newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' }),
    batchFixture())
  expect(phaseLoop(singlePr, mkTask({ tier: 'light' }))).toBe([
    ...HEAD,
    '5. `implement` — a subagent writes the code and tests; you verify, push and run `hpipe submit`',
    '6. `pr-review` — one review of the change, intent then quality',
    '7. `sync` — if the batch moves before you land: merge it in, check, push, submit',
  ].join('\n'))
  expect(phaseLoop(singlePr, mkTask())).toContain('7. `pr-review` — one review of the change, intent then quality')
})

test('the loop carries its paths as text, never as a token render() would pass through', () => {
  for (const tier of TIERS) expect(phaseLoop(PER_TASK, mkTask({ tier }))).not.toContain('{{')
})

test('the tier variables name the tier, the task, its agent file and the implement model', () => {
  expect(tierPromptVars(PER_TASK, mkTask({ surface: 'web', tier: 'light' }))).toMatchObject({
    tier: 'light', task_id: 't1', agent_file: '.claude/agents/web-dev.md', implement_model: 'sonnet',
  })
  expect(tierPromptVars(PER_TASK, mkTask()).tier).toBe('heavy')
})

test('review_effort follows the task\'s current tier, so a raised task gets the heavier review', () => {
  expect(tierPromptVars(PER_TASK, mkTask({ tier: 'light' })).review_effort).toBe('high')
  expect(tierPromptVars(PER_TASK, mkTask({ tier: 'standard' })).review_effort).toBe('high')
  expect(tierPromptVars(PER_TASK, mkTask({ tier: 'heavy' })).review_effort).toBe('xhigh')
})

test('the plan wording follows whether a plan review ran, not the current tier', () => {
  const raisedAfterSkipping = tierPromptVars(PER_TASK, mkTask({ tier: 'standard' }))
  expect(raisedAfterSkipping.plan_status)
    .toBe('was not reviewed — read it critically, and fix it first if it is wrong')
  expect(raisedAfterSkipping.plan_review_note)
    .toBe('No plan review ran; judge the plan\'s soundness from the diff as well.')

  const loweredAfterReview = tierPromptVars(PER_TASK, mkTask({ tier: 'light', verdict_seq: { 'plan-review': 1 } }))
  expect(loweredAfterReview.plan_status).toBe('cleared review')
  expect(loweredAfterReview.plan_review_note).toBe('')
})

test('review_count says both stages only when pr-review-quality ran', () => {
  expect(tierPromptVars(PER_TASK, mkTask({ verdict_seq: { 'pr-review-intent': 1, 'pr-review-quality': 1 } })).review_count)
    .toBe('Both review stages cleared')
  expect(tierPromptVars(PER_TASK, mkTask({ tier: 'light', verdict_seq: { 'pr-review-intent': 1 } })).review_count)
    .toBe('Review cleared')
  expect(tierPromptVars(PER_TASK, mkTask({ tier: 'light', verdict_seq: { 'pr-review': 1 } })).review_count)
    .toBe('Review cleared')
})

test('review_count says the PR review was skipped, and why, when it was', () => {
  const review_skip = { at: 1, skipped: ['pr-review'] as TaskPhase[], added_lines: 42, cleared: ['spec-review', 'plan-review'] as TaskPhase[] }
  expect(tierPromptVars(PER_TASK, mkTask({ tier: 'standard', review_skip })).review_count)
    .toBe('The PR review was skipped (42 lines added outside docs/, spec-review and plan-review cleared first pass)')
})

test('taskTiers names every task with its tier', () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  expect(taskTiers(run)).toBe('none')
  run.tasks = [mkTask({ task_id: 't1', tier: 'light' }), mkTask({ task_id: 't2' })]
  expect(taskTiers(run)).toBe('t1 light, t2 heavy')
})

const TIER_TOKENS =
  '{{tier}}|{{task_id}}|{{agent_file}}|{{implement_model}}|{{review_effort}}|{{plan_status}}|{{review_count}}|' +
  '{{plan_review_note}}|{{phase_loop}}'

const COMMON_PROMPTS = [
  'research', 'spec', 'spec-review', 'plan', 'plan-review', 'implement', 'ci-red', 'pr-review',
  'pr-review-intent', 'pr-review-quality', 'merge',
]

function probeRoot(): string {
  const root = tempDir('hpipe-probe-')
  mkdirSync(join(root, 'prompts'))
  for (const name of [...COMMON_PROMPTS, 'worker-brief', 'decision']) {
    writeFileSync(join(root, 'prompts', `${name}.md`), TIER_TOKENS)
  }
  for (const fragment of ['handoff-pr', 'handoff-batch']) writeFileSync(join(root, 'prompts', `${fragment}.md`), '')
  writeFileSync(join(root, 'prompts', 'branch-review.md'), '{{task_tiers}}|{{review_effort}}')
  return root
}

function runWithOne(task: Task): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [task]
  return run
}

const PROBED = 'heavy|t1|.claude/agents/core-dev.md|sonnet|xhigh|'

test('every task render site carries the tier variables', async () => {
  const root = probeRoot()
  const deps = { pluginRoot: root, ciDetail: async () => '' }
  const phases: TaskPhase[] = [
    'research', 'spec', 'spec-review', 'plan', 'plan-review', 'implement', 'pr-review',
    'pr-review-intent', 'pr-review-quality', 'merge',
  ]
  for (const phase of phases) {
    const task = mkTask({ phase })
    expect(await renderTaskPhasePrompt(runWithOne(task), task, deps, phase), phase).toContain(PROBED)
  }
  const fromCi = mkTask({ phase: 'implement' })
  expect(await renderTaskPhasePrompt(runWithOne(fromCi), fromCi, deps, 'ci')).toContain(PROBED)

  const briefed = mkTask({ phase: 'research' })
  expect(await renderWorkerPrompt(root, runWithOne(briefed), briefed)).toContain(PROBED)

  const asking = mkTask({ phase: 'blocked-on-decision', decision_from: 'plan' })
  openDecision(asking, { question: 'q', recommendation: 'r' })
  const sent: string[] = []
  await announceDecisions(runWithOne(asking), {
    pluginRoot: root, promptRetryMax: 5,
    send: async (_pane, text) => { sent.push(text); return { ok: true } },
    checkSubmission: async () => ({ state: 'submitted' }),
  })
  expect(sent[0]).toContain(PROBED)

  const finished = runWithOne(mkTask({ task_id: 't1', tier: 'light' }))
  finished.phase = 'branch-review'
  expect(await renderRunPhasePrompt(finished, root)).toBe('t1 light|high')
})
