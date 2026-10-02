import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDecision } from '../src/lib/decisions'
import { newRun } from '../src/lib/ledger'
import { IMPLEMENT_MODEL } from '../src/lib/models'
import { TIERS } from '../src/lib/phases'
import { phaseLoop, taskTiers, tierPromptVars } from '../src/lib/tier-prompt'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import { renderWorkerPrompt } from '../src/lib/worker-prompt'
import { renderRunPhasePrompt } from '../src/supervisor/deliver'
import { announceDecisions, renderTaskPhasePrompt } from '../src/supervisor/tasks'
import { cleanupFixtures, tempDir } from './helpers/git-worktree'
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

const HEAD = [
  '1. `research` → `docs/r.md`',
  '2. `spec` → `docs/s.md`',
  '3. `spec-review` — you dispatch the reviewer',
  '4. `plan` → `docs/p.md`',
]

test('only implement\'s coding subagent is pinned, to sonnet', () => {
  expect(IMPLEMENT_MODEL).toBe('sonnet')
})

test('the light loop skips plan-review and runs one combined PR review', () => {
  expect(phaseLoop(mkTask({ tier: 'light' }))).toBe([
    ...HEAD,
    '5. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '6. `pr-review` — one review of the PR, intent then quality',
  ].join('\n'))
})

test('the standard loop keeps plan-review and the combined PR review', () => {
  expect(phaseLoop(mkTask({ tier: 'standard' }))).toBe([
    ...HEAD,
    '5. `plan-review` — you dispatch the reviewer again',
    '6. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '7. `pr-review` — one review of the PR, intent then quality',
  ].join('\n'))
})

test('the heavy loop runs both PR stages, as every task did before tiers', () => {
  expect(phaseLoop(mkTask())).toBe([
    ...HEAD,
    '5. `plan-review` — you dispatch the reviewer again',
    '6. `implement` — a subagent writes the code and tests; you verify, push and open the PR',
    '7. `pr-review-intent` — does the PR do what was asked',
    '8. `pr-review-quality` — is it written the way this codebase is',
  ].join('\n'))
})

test('the loop carries its paths as text, never as a token render() would pass through', () => {
  for (const tier of TIERS) expect(phaseLoop(mkTask({ tier }))).not.toContain('{{')
})

test('the tier variables name the tier, the task, its agent file and the implement model', () => {
  expect(tierPromptVars(mkTask({ surface: 'web', tier: 'light' }))).toMatchObject({
    tier: 'light', task_id: 't1', agent_file: '.claude/agents/web-dev.md', implement_model: 'sonnet',
  })
  expect(tierPromptVars(mkTask()).tier).toBe('heavy')
})

test('the plan wording follows whether a plan review ran, not the current tier', () => {
  const raisedAfterSkipping = tierPromptVars(mkTask({ tier: 'standard' }))
  expect(raisedAfterSkipping.plan_status)
    .toBe('was not reviewed — read it critically, and fix it first if it is wrong')
  expect(raisedAfterSkipping.plan_review_note)
    .toBe('No plan review ran; judge the plan\'s soundness from the diff as well.')

  const loweredAfterReview = tierPromptVars(mkTask({ tier: 'light', verdict_seq: { 'plan-review': 1 } }))
  expect(loweredAfterReview.plan_status).toBe('cleared review')
  expect(loweredAfterReview.plan_review_note).toBe('')
})

test('review_count says both stages only when pr-review-quality ran', () => {
  expect(tierPromptVars(mkTask({ verdict_seq: { 'pr-review-intent': 1, 'pr-review-quality': 1 } })).review_count)
    .toBe('Both review stages cleared')
  expect(tierPromptVars(mkTask({ tier: 'light', verdict_seq: { 'pr-review-intent': 1 } })).review_count)
    .toBe('Review cleared')
  expect(tierPromptVars(mkTask({ tier: 'light', verdict_seq: { 'pr-review': 1 } })).review_count)
    .toBe('Review cleared')
})

test('taskTiers names every task with its tier', () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  expect(taskTiers(run)).toBe('none')
  run.tasks = [mkTask({ task_id: 't1', tier: 'light' }), mkTask({ task_id: 't2' })]
  expect(taskTiers(run)).toBe('t1 light, t2 heavy')
})

const TIER_TOKENS =
  '{{tier}}|{{task_id}}|{{agent_file}}|{{implement_model}}|{{plan_status}}|{{review_count}}|' +
  '{{plan_review_note}}|{{phase_loop}}'

const COMMON_PROMPTS = [
  'research', 'spec', 'spec-review', 'plan', 'plan-review', 'implement', 'ci-red', 'pr-review',
  'pr-review-intent', 'pr-review-quality', 'merge', 'close',
]

function probeRoot(): string {
  const root = tempDir('hpipe-probe-')
  mkdirSync(join(root, 'prompts'))
  for (const name of [...COMMON_PROMPTS, 'worker-brief', 'decision']) {
    writeFileSync(join(root, 'prompts', `${name}.md`), TIER_TOKENS)
  }
  writeFileSync(join(root, 'prompts', 'branch-review.md'), '{{task_tiers}}')
  return root
}

function runWithOne(task: Task): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [task]
  return run
}

const PROBED = 'heavy|t1|.claude/agents/core-dev.md|sonnet|'

test('every task render site carries the tier variables', async () => {
  const root = probeRoot()
  const deps = { pluginRoot: root, ciDetail: async () => '' }
  const phases: TaskPhase[] = [
    'research', 'spec', 'spec-review', 'plan', 'plan-review', 'implement', 'pr-review',
    'pr-review-intent', 'pr-review-quality', 'merge', 'close',
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
  expect(await renderRunPhasePrompt(finished, root)).toBe('t1 light')
})
