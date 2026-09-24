import { expect, test } from 'bun:test'
import { newRun } from '../src/lib/ledger'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import {
  overdueUnstartedWorker, startWorkerCommand, UNSTARTED_GRACE_MS, unstartedWorker,
} from '../src/lib/unstarted'

const NOW = 10_000_000
const ADOPTED = NOW - UNSTARTED_GRACE_MS

const mkRun = (): Run => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  return run
}

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w23', pane_id: null, agent_status: 'unknown',
  phase: 'research', phase_entered_at: ADOPTED - 60_000, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/wt', registered_at: 0, adopted_at: ADOPTED,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

test('a bound worktree with no agent detected in it is an unstarted worker', () => {
  expect(unstartedWorker(mkRun(), mkTask({}))).toEqual({ workspaceId: 'w23', since: ADOPTED })
})

test('a task with a pane, or with no worktree yet, is not', () => {
  expect(unstartedWorker(mkRun(), mkTask({ pane_id: 'w23:p1' }))).toBeNull()
  // No worktree is the never-dispatched case, which stallAwaiting already names.
  expect(unstartedWorker(mkRun(), mkTask({ workspace_id: null }))).toBeNull()
})

test('only a row a worker owns needs an agent in the worktree', () => {
  for (const phase of ['queued', 'blocked-on-files', 'ci', 'merge', 'close', 'teardown',
                       'blocked-on-decision', 'escalated', 'failed', 'done'] as TaskPhase[]) {
    expect(unstartedWorker(mkRun(), mkTask({ phase })), phase).toBeNull()
  }
})

test('a run in a pane-releasing phase is not being driven, so nothing is owed', () => {
  const run = mkRun()
  run.phase = 'done'
  expect(unstartedWorker(run, mkTask({}))).toBeNull()
})

test('a record whose adoption stamp a dispatch rewind cleared dates from its phase entry', () => {
  const task = mkTask({ adopted_at: null, phase_entered_at: 42 })
  expect(unstartedWorker(mkRun(), task)?.since).toBe(42)
})

test('it is overdue only once the bootstrap grace has passed since adoption', () => {
  const run = mkRun()
  expect(overdueUnstartedWorker(run, mkTask({}), NOW)).not.toBeNull()
  expect(overdueUnstartedWorker(run, mkTask({}), NOW - 1)).toBeNull()
})

test('the command names the workspace to find the pane in and the dispatch handover', () => {
  const text = startWorkerCommand(mkTask({}), 'w23', 'hp')
  expect(text).toContain('herdr pane list --workspace w23')
  expect(text).toContain('herdr agent start')
  expect(text).toContain('`hp dispatch --task t1 --pane <pane>`')
  expect(text).not.toMatch(/(^|[^/])hpipe /)
})
