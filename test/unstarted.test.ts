import { expect, test } from 'bun:test'
import { newRun } from '../src/lib/ledger'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import {
  bindWorkerPane, dispatchSequence, dispatchWorkerCommand, overdueUnstartedWorker, startWorkerCommand,
  UNSTARTED_GRACE_MS, unstartedWorker,
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

test('the command looks for an agent before starting one, then hands the brief over', () => {
  const text = startWorkerCommand(mkRun(), mkTask({}), 'w23', 'hp')
  expect(text.indexOf('herdr pane list --workspace w23'))
    .toBeLessThan(text.indexOf('herdr agent start'))
  expect(text).toContain('its detection was missed')
  expect(text).toContain('`hp dispatch --task t1 --pane <pane>`')
  expect(text).not.toMatch(/(^|[^/])hpipe /)
})

test('past the briefed phase the command does not offer the dispatch that would refuse it', () => {
  const text = startWorkerCommand(mkRun(), mkTask({ phase: 'implement' }), 'w23', 'hp')
  expect(text).not.toContain('dispatch --task')
  expect(text).toContain('`hp brief --task t1`')
  expect(text).toContain('in implement')
})

const FETCHED = { commit: 'c0ffee1', ref: 'origin/main', fetchError: null }

test('the dispatch sequence runs worktree, bootstrap, a flagged agent start, then the brief — #118', () => {
  expect(dispatchSequence(mkRun(), mkTask({}), FETCHED, { kind: 'ready' }, 'hp').split('\n')).toEqual([
    'dispatch, in order:',
    '    herdr worktree create --cwd /r --branch feat/x --base c0ffee1',
    '    (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)',
    '    herdr agent start <name> --kind claude --pane <.result.root_pane.pane_id> -- --dangerously-skip-permissions',
    '    hp dispatch --task t1 --pane <.result.root_pane.pane_id>',
  ])
})

test('a repo with no bootstrap gets no bootstrap step; a failed fetch still names the stale commit', () => {
  const text = dispatchSequence(mkRun(), mkTask({}), { ...FETCHED, fetchError: 'timed out' }, { kind: 'none' }, 'hp')
  expect(text).not.toContain('pipeline-bootstrap')
  expect(text).toContain('--base c0ffee1')
})

test('every recovery path starts the agent with the same flag as the dispatch — #118', () => {
  for (const text of [
    startWorkerCommand(mkRun(), mkTask({}), 'w23', 'hp'),
    dispatchWorkerCommand(mkRun(), mkTask({ workspace_id: null, checkout_path: null }), 'hp'),
  ]) {
    expect(text).toContain('--pane <root pane> -- --dangerously-skip-permissions`')
  }
})

test('the recovery create is cut from the task\'s base: commit, never main — #121', () => {
  for (const checkout of [null, '/wt']) {
    const text = dispatchWorkerCommand(mkRun(), mkTask({ workspace_id: null, checkout_path: checkout }), 'hp')
    expect(text).toContain('--base <commit>` (the commit on this task\'s `base:` line, never a base you pick)')
    expect(text).not.toContain('--base main')
  }
})

test('binding a pane re-arms the ladder from now; rebinding the same pane changes nothing', () => {
  const run = mkRun()
  const task = mkTask({})
  task.stall = { at: task.phase_entered_at, run_at: run.phase_entered_at,
                 last_probe_at: 1, probes: 3, undelivered: 2, holds: 1 }
  expect(bindWorkerPane(run, task, 'w23:p1', NOW)).toBe(true)
  expect(task.pane_id).toBe('w23:p1')
  expect(task.stall).toEqual({ at: task.phase_entered_at, run_at: run.phase_entered_at,
                               last_probe_at: NOW, probes: 0, undelivered: 0, holds: 0 })
  expect(bindWorkerPane(run, task, 'w23:p1', NOW + 1)).toBe(false)
  expect(task.stall?.last_probe_at).toBe(NOW)
})
