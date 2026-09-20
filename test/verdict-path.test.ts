import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REVIEWS_DIR, reserveVerdict, verdictBase, verdictFilename, verdictFor, verdictPrefix,
} from '../src/lib/verdict-path'
import { newRun } from '../src/lib/ledger'
import { cleanupFixtures, tempDir } from './helpers/git-worktree'
import type { Run, Task } from '../src/lib/types'

afterEach(cleanupFixtures)

const mkTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 26, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'spec-review', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/w', registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

const mkRun = (): Run =>
  newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })

test('a verdict filename is repo-relative and carries prefix, phase and ordinal', () => {
  expect(REVIEWS_DIR).toBe('docs/superpowers/reviews')
  expect(verdictFilename('issue-26', 'spec-review', 2))
    .toBe('docs/superpowers/reviews/issue-26-spec-review-2.md')
})

test('the prefix is the issue for a task and the run id for a run', () => {
  const run = mkRun()
  expect(verdictPrefix(run, mkTask({ issue: 26 }))).toBe('issue-26')
  expect(verdictPrefix(run, null)).toBe(run.run_id)
})

test('the base is the checkout when set and the repo root when not', () => {
  const run = mkRun()
  expect(verdictBase(run, mkTask({ checkout_path: '/w' }))).toBe('/w')
  expect(verdictBase(run, mkTask({ checkout_path: null }))).toBe('/r')
  expect(verdictBase(run, null)).toBe('/r')
})

test('nothing is recorded until a review is commissioned', () => {
  expect(verdictFor(mkTask(), 'spec-review')).toBeNull()
})

test('a recorded verdict is read back under the key verdict_seq names', () => {
  const task = mkTask({
    verdict_seq: { 'spec-review': 2 },
    artifacts: {
      research: null, spec: null, plan: null,
      verdicts: { 'spec-review-0': 'first.md', 'spec-review-1': 'second.md' },
    },
  })
  expect(verdictFor(task, 'spec-review')).toBe('second.md')
})

test('a recorded entry with no verdict_seq is invisible to the reader', () => {
  const task = mkTask({
    artifacts: {
      research: null, spec: null, plan: null, verdicts: { 'spec-review-0': 'first.md' },
    },
  })
  expect(verdictFor(task, 'spec-review')).toBeNull()
})

function checkoutHolding(...relatives: string[]): string {
  const dir = tempDir('hpipe-verdict-')
  mkdirSync(join(dir, REVIEWS_DIR), { recursive: true })
  for (const rel of relatives) writeFileSync(join(dir, rel), 'VERDICT: CLEAR\n')
  return dir
}

test('the first reservation takes ordinal 0 and the reader agrees', () => {
  const run = mkRun()
  const task = mkTask({ checkout_path: checkoutHolding() })

  const reserved = reserveVerdict(run, task, 'spec-review')

  expect(reserved).toBe('docs/superpowers/reviews/issue-26-spec-review-0.md')
  expect(task.verdict_seq?.['spec-review']).toBe(1)
  expect(verdictFor(task, 'spec-review')).toBe(reserved)
})

test('the reader agrees with the reserver even when the map has a gap', () => {
  const run = mkRun()
  const task = mkTask({
    checkout_path: checkoutHolding(),
    verdict_seq: { 'spec-review': 3 },
    artifacts: {
      research: null, spec: null, plan: null,
      verdicts: { 'spec-review-2': 'docs/superpowers/reviews/issue-26-spec-review-9.md' },
    },
  })

  const reserved = reserveVerdict(run, task, 'spec-review')

  expect(reserved).toBe('docs/superpowers/reviews/issue-26-spec-review-3.md')
  expect(verdictFor(task, 'spec-review')).toBe(reserved)
})

test('a filename already on disk is skipped', () => {
  const run = mkRun()
  const task = mkTask({
    checkout_path: checkoutHolding(
      'docs/superpowers/reviews/issue-26-spec-review-0.md',
      'docs/superpowers/reviews/issue-26-spec-review-1.md',
    ),
  })

  expect(reserveVerdict(run, task, 'spec-review'))
    .toBe('docs/superpowers/reviews/issue-26-spec-review-2.md')
})

test('freeing a name on disk never moves what an existing key resolves to', () => {
  const run = mkRun()
  const checkout = checkoutHolding('docs/superpowers/reviews/issue-26-spec-review-0.md')
  const task = mkTask({ checkout_path: checkout })

  const first = reserveVerdict(run, task, 'spec-review')
  expect(first).toBe('docs/superpowers/reviews/issue-26-spec-review-1.md')

  // The `git mv` preservation workaround, applied four times in this repo's history.
  rmSync(join(checkout, 'docs/superpowers/reviews/issue-26-spec-review-0.md'))
  const second = reserveVerdict(run, task, 'spec-review')

  expect(task.artifacts.verdicts['spec-review-0']).toBe(first)
  expect(second).not.toBe(first)
  expect(second).not.toBe('docs/superpowers/reviews/issue-26-spec-review-0.md')
})

test('a filename already held in the map is skipped even when absent from disk', () => {
  const run = mkRun()
  const task = mkTask({
    checkout_path: checkoutHolding(),
    verdict_seq: { 'spec-review': 1 },
    artifacts: {
      research: null, spec: null, plan: null,
      verdicts: { 'spec-review-0': 'docs/superpowers/reviews/issue-26-spec-review-1.md' },
    },
  })

  expect(reserveVerdict(run, task, 'spec-review'))
    .toBe('docs/superpowers/reviews/issue-26-spec-review-2.md')
})

test('an exhausted probe records the floor so the key and the prompt still agree', () => {
  const run = mkRun()
  const held: Record<string, string> = {}
  for (let i = 0; i < 64; i++) {
    held[`held-${i}`] = `docs/superpowers/reviews/issue-26-spec-review-${i}.md`
  }
  const task = mkTask({
    checkout_path: checkoutHolding(),
    artifacts: { research: null, spec: null, plan: null, verdicts: held },
  })

  const reserved = reserveVerdict(run, task, 'spec-review')

  expect(reserved).toBe('docs/superpowers/reviews/issue-26-spec-review-0.md')
  expect(verdictFor(task, 'spec-review')).toBe(reserved)
})

test('a run reserves under its run id against the repo root', () => {
  const run = mkRun()
  run.repo_root = checkoutHolding()

  const reserved = reserveVerdict(run, null, 'branch-review')

  expect(reserved).toBe(`docs/superpowers/reviews/${run.run_id}-branch-review-0.md`)
  expect(verdictFor(run, 'branch-review')).toBe(reserved)
})
