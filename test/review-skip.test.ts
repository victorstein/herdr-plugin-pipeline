import { expect, test } from 'bun:test'
import { newRun, withBatch } from '../src/lib/ledger'
import {
  alwaysReviewPrefixes, changeSize, describeReviewSkip, notSkippedBecause, PR_REVIEW_SKIP_BELOW_ADDED_LINES,
  prReviewsOn, reviewCall, reviewSkip, skipCandidate, skipReason,
} from '../src/lib/review-skip'
import type { HistoryEntry, Run, Task, TaskPhase, Tier } from '../src/lib/types'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

const mkTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'implement', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: 7, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

const step = (from: string, to: string, task_id = 't1'): HistoryEntry => ({ at: 1, task_id, from, to, why: 'test' })

const CLEARED_DESIGN: HistoryEntry[] = [
  step('queued', 'research'), step('research', 'spec'), step('spec', 'spec-review'), step('spec-review', 'plan'),
  step('plan', 'plan-review'), step('plan-review', 'blocked-on-files'), step('blocked-on-files', 'implement'),
]

function runOf(tier: Tier, history: HistoryEntry[], singlePr = false): { run: Run; task: Task } {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  const task = mkTask({ tier })
  run.tasks = [task]
  run.history = history
  return { run: singlePr ? withBatch(run, batchFixture()) : run, task }
}

test('the threshold is one named constant: fewer than 150 lines added outside docs/', () => {
  expect(PR_REVIEW_SKIP_BELOW_ADDED_LINES).toBe(150)
})

test('the PR review rows on a route are what implement clears into, and the row after them', () => {
  for (const tier of ['light', 'standard', 'heavy'] as const) {
    expect(prReviewsOn({ tier, mode: 'per-task' })).toEqual({ reviews: ['pr-review'], next: 'ci' })
    expect(prReviewsOn({ tier, mode: 'single-pr' })).toEqual({ reviews: ['pr-review'], next: 'land-queue' })
  }
})

test('a standard task whose spec and plan reviews both cleared first time is a candidate', () => {
  const { run, task } = runOf('standard', CLEARED_DESIGN)
  expect(skipCandidate(run, task)).toEqual({
    skipped: ['pr-review'], next: 'ci', cleared: ['spec-review', 'plan-review'],
  })
})

test('a light task needs only its spec review, the one design review its route runs', () => {
  const { run, task } = runOf('light', [step('spec', 'spec-review'), step('spec-review', 'plan')], true)
  expect(skipCandidate(run, task)).toEqual({ skipped: ['pr-review'], next: 'land-queue', cleared: ['spec-review'] })
})

test('heavy never skips', () => {
  const { run, task } = runOf('heavy', CLEARED_DESIGN)
  expect(skipCandidate(run, task)).toBeNull()
})

test('a design review that sent the work back, or escalated, makes no candidate', () => {
  for (const [label, extra] of [
    ['spec send-back', [step('spec-review', 'spec')]],
    ['plan send-back', [step('plan-review', 'plan')]],
    ['spec escalation', [step('spec-review', 'escalated')]],
  ] as const) {
    const { run, task } = runOf('standard', [...extra, ...CLEARED_DESIGN])
    expect(skipCandidate(run, task), label).toBeNull()
  }
})

test('a design review the route runs but the task never passed makes no candidate', () => {
  const raisedPastPlan = CLEARED_DESIGN.filter((h) => h.from !== 'plan-review' && h.to !== 'plan-review')
  const { run, task } = runOf('standard', raisedPastPlan)
  expect(skipCandidate(run, task)).toBeNull()
})

test('a light or standard task that is no candidate says why its PR review runs; heavy says nothing', () => {
  const cases: Array<[Tier, HistoryEntry[], string | null]> = [
    ['standard', [step('plan-review', 'plan'), ...CLEARED_DESIGN], 'plan-review sent it back'],
    ['standard', [step('spec-review', 'escalated'), ...CLEARED_DESIGN], 'spec-review escalated it'],
    ['standard', CLEARED_DESIGN.filter((h) => h.from !== 'plan-review' && h.to !== 'plan-review'),
      'plan-review never cleared'],
    ['heavy', CLEARED_DESIGN, null],
    ['standard', CLEARED_DESIGN, null],
  ]
  for (const [tier, history, why] of cases) {
    const { run, task } = runOf(tier, history)
    expect(notSkippedBecause(run, task), why ?? tier).toBe(why)
  }
})

test('a decision asked during a design review is not a send-back', () => {
  const { run, task } = runOf('standard', [
    step('spec-review', 'blocked-on-decision'), step('blocked-on-decision', 'spec-review'), ...CLEARED_DESIGN,
  ])
  expect(skipCandidate(run, task)?.cleared).toEqual(['spec-review', 'plan-review'])
})

test('a PR review that already sent the task back must see the fix', () => {
  for (const sentBackFrom of ['pr-review', 'pr-review-intent', 'pr-review-quality'] as const) {
    const { run, task } = runOf('standard', [...CLEARED_DESIGN, step('implement', 'pr-review'),
      step(sentBackFrom, 'implement')])
    expect(skipCandidate(run, task), sentBackFrom).toBeNull()
  }
})

test('a design review that sent the work back still counts after the tier is lowered past it', () => {
  const { run, task } = runOf('light', [...CLEARED_DESIGN, step('plan-review', 'plan')])
  expect(skipCandidate(run, task)).toBeNull()
})

test('another task\'s history is not this task\'s', () => {
  const { run, task } = runOf('standard', [...CLEARED_DESIGN, step('spec-review', 'spec', 't2')])
  expect(skipCandidate(run, task)).not.toBeNull()
})

test('the change size counts lines added outside docs/, and every path it touches', () => {
  expect(changeSize('10\t2\tsrc/a.ts\n300\t0\tdocs/guide.md\n5\t5\ttest/a.test.ts\n')).toEqual({
    added: 15, paths: ['src/a.ts', 'docs/guide.md', 'test/a.test.ts'],
  })
  expect(changeSize('')).toEqual({ added: 0, paths: [] })
})

test('a binary file outside docs/ cannot be sized, so the change is unmeasured', () => {
  expect(changeSize('-\t-\tassets/logo.png\n')).toBeNull()
  expect(changeSize('-\t-\tdocs/diagram.png\n1\t0\tsrc/a.ts\n')).toEqual({
    added: 1, paths: ['docs/diagram.png', 'src/a.ts'],
  })
})

test('a numstat line that is not one is unmeasured, never zero', () => {
  expect(changeSize('fatal: bad revision\n')).toBeNull()
})

test('the always-review list is one prefix per line, with # comments and globs cut to their prefix', () => {
  expect(alwaysReviewPrefixes([
    '# security-sensitive', '', 'src/auth/', '  ./migrations/  # schema', 'src/**/secrets.ts', '/infra/',
  ].join('\n'))).toEqual(['src/auth/', 'migrations/', 'src/', 'infra/'])
})

const CANDIDATE = { skipped: ['pr-review'] as TaskPhase[], next: 'ci' as TaskPhase, cleared: ['spec-review'] as TaskPhase[] }

test('a small change touching nothing on the always-review list skips', () => {
  expect(reviewSkip(CANDIDATE, { added: 149, paths: ['src/a.ts'] }, ['src/auth/'], 5)).toEqual({
    at: 5, skipped: ['pr-review'], added_lines: 149, cleared: ['spec-review'],
  })
})

test('a change to the always-review list itself is always reviewed, listed or not', () => {
  expect(reviewSkip(CANDIDATE, { added: 1, paths: ['.claude/pipeline-always-review'] }, [], 5)).toBeNull()
})

test('a change at the threshold, an unmeasured one, or one touching the list does not skip', () => {
  expect(reviewSkip(CANDIDATE, { added: 150, paths: ['src/a.ts'] }, [], 5)).toBeNull()
  expect(reviewSkip(CANDIDATE, null, [], 5)).toBeNull()
  expect(reviewSkip(CANDIDATE, { added: 1, paths: ['src/a.ts'] }, null, 5)).toBeNull()
  expect(reviewSkip(CANDIDATE, { added: 1, paths: ['docs/x.md', 'src/auth/token.ts'] }, ['src/auth/'], 5)).toBeNull()
})

test('a change that does not skip says why: its size, the list, or what could not be read', () => {
  // The trial's t2 added 167 lines outside docs/ and its history said only what it submitted. Measured on a live run.
  expect(reviewCall(CANDIDATE, { added: 167, paths: ['src/a.ts'] }, [], 5))
    .toEqual({ reviewedBecause: '167 lines added outside docs/ (a skip needs fewer than 150)' })
  expect(reviewCall(CANDIDATE, { added: 1, paths: ['docs/x.md', 'src/auth/token.ts'] }, ['src/auth/'], 5))
    .toEqual({ reviewedBecause: `src/auth/token.ts is on ${'.claude/pipeline-always-review'}` })
  expect(reviewCall(CANDIDATE, { added: 1, paths: ['.claude/pipeline-always-review'] }, [], 5))
    .toEqual({ reviewedBecause: 'it edits .claude/pipeline-always-review' })
  expect(reviewCall(CANDIDATE, null, [], 5)).toEqual({ reviewedBecause: 'its change could not be measured' })
  expect(reviewCall(CANDIDATE, { added: 1, paths: ['src/a.ts'] }, null, 5))
    .toEqual({ reviewedBecause: '.claude/pipeline-always-review could not be read at its base' })
  expect(reviewCall(CANDIDATE, { added: 149, paths: ['src/a.ts'] }, [], 5)).toEqual({
    skip: { at: 5, skipped: ['pr-review'], added_lines: 149, cleared: ['spec-review'] },
  })
})

test('the skip reads as the rows skipped and the numbers behind it', () => {
  const skip = { at: 5, skipped: ['pr-review'] as TaskPhase[], added_lines: 42, cleared: ['spec-review', 'plan-review'] as TaskPhase[] }
  expect(describeReviewSkip(skip))
    .toBe('pr-review skipped: 42 lines added outside docs/, spec-review and plan-review cleared first pass')
  expect(skipReason({ ...skip, added_lines: 1, cleared: ['spec-review'] }))
    .toBe('1 line added outside docs/, spec-review cleared first pass')
})
