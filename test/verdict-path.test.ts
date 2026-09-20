import { afterEach, expect, test } from 'bun:test'
import { REVIEWS_DIR, verdictBase, verdictFilename, verdictPrefix } from '../src/lib/verdict-path'
import { newRun } from '../src/lib/ledger'
import { cleanupFixtures } from './helpers/git-worktree'
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
