import { expect, test } from 'bun:test'
import { newRun } from '../src/lib/ledger'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import {
  bindWorkerPane, briefCommand, dispatchSequence, dispatchWorkerCommand, overdueUnstartedWorker, remainingDispatchSteps,
  startWorkerCommand, UNSTARTED_GRACE_MS, unstartedWorker,
} from '../src/lib/unstarted'
import { beadTaskFields } from './helpers/bead-fields'

const NOW = 10_000_000
const ADOPTED = NOW - UNSTARTED_GRACE_MS

const mkRun = (): Run => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  return run
}

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w23', pane_id: null, agent_status: 'unknown',
  phase: 'research', phase_entered_at: ADOPTED - 60_000, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/wt', registered_at: 0, adopted_at: ADOPTED,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
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

const ONE_COMMAND = 'dispatch: hp dispatch --task t1 (run it in the background) — runs the steps below and stops at ' +
  'the first failure; the block is the manual fallback'

const WHERE_CREATE_PUTS_IT = '    # its JSON gives the new checkout as .result.worktree.path and its pane as ' +
  '.result.root_pane.pane_id; `hp show --task t1` prints the checkout too'

test('the dispatch sequence runs worktree, bootstrap, a flagged agent start, then the brief — #118', () => {
  expect(dispatchSequence(mkRun(), mkTask({}), FETCHED, { kind: 'ready' }, 'hp').split('\n')).toEqual([
    ONE_COMMAND,
    'dispatch, in order:',
    "    herdr worktree create --cwd '/r' --branch feat/x --base c0ffee1",
    WHERE_CREATE_PUTS_IT,
    '    (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)',
    '    herdr agent start hp-1 --kind claude --pane <.result.root_pane.pane_id> -- --dangerously-skip-permissions --effort high',
    '    hp dispatch --task t1 --pane <.result.root_pane.pane_id>',
  ])
})

test('a repo with no bootstrap gets no bootstrap step; a failed fetch still names the stale commit', () => {
  const text = dispatchSequence(mkRun(), mkTask({}), { ...FETCHED, fetchError: 'timed out' }, { kind: 'none' }, 'hp')
  expect(text).not.toContain('pipeline-bootstrap')
  expect(text).not.toContain('optional')
  expect(text).toContain('--base c0ffee1')
})

test('a setup script that is not executable is offered as no step', () => {
  const text = dispatchSequence(mkRun(), mkTask({}), FETCHED,
    { kind: 'none', unwired: 'scripts/bootstrap.sh', notExecutable: true }, 'hp')
  expect(text).not.toContain('optional')
  expect(text).not.toContain('bootstrap.sh')
})

test('a setup script the repo never wired in is an optional step in the new checkout, not dropped', () => {
  // The trial's orchestrator dug the checkout path out of the create JSON to run ./bin/bootstrap by hand.
  // Measured on a live run.
  expect(dispatchSequence(mkRun(), mkTask({}), FETCHED, { kind: 'none', unwired: 'bin/bootstrap' }, 'hp').split('\n'))
    .toEqual([
      ONE_COMMAND,
      'dispatch, in order:',
      "    herdr worktree create --cwd '/r' --branch feat/x --base c0ffee1",
      WHERE_CREATE_PUTS_IT,
      '    (cd "<.result.worktree.path>" && ./bin/bootstrap)  # optional: the repo\'s own setup, which nothing ' +
        'runs for you; run it if the worker will need what it sets up',
      '    herdr agent start hp-1 --kind claude --pane <.result.root_pane.pane_id> -- --dangerously-skip-permissions --effort high',
      '    hp dispatch --task t1 --pane <.result.root_pane.pane_id>',
    ])
})

test('a repo path is quoted for the shell it is pasted into', () => {
  const run = mkRun()
  run.repo_root = "/My Repos/it's"
  const text = dispatchSequence(run, mkTask({}), FETCHED, { kind: 'none' }, 'hp')
  expect(text).toContain(`--cwd '/My Repos/it'\\''s' --branch`)
})

test('every recovery path starts the agent with the same flags as the dispatch — #118', () => {
  for (const text of [
    startWorkerCommand(mkRun(), mkTask({}), 'w23', 'hp'),
    dispatchWorkerCommand(mkRun(), mkTask({ workspace_id: null, checkout_path: null }), 'hp'),
    remainingDispatchSteps(mkRun(), mkTask({}), 'hp'),
  ]) {
    expect(text).toContain('--pane <root pane> -- --dangerously-skip-permissions --effort high`')
  }
})

test('every path names the agent by its bead, so the line runs as printed and `herdr agent list` says whose it is', () => {
  for (const text of [
    dispatchSequence(mkRun(), mkTask({}), FETCHED, { kind: 'none' }, 'hp'),
    startWorkerCommand(mkRun(), mkTask({}), 'w23', 'hp'),
    dispatchWorkerCommand(mkRun(), mkTask({ workspace_id: null, checkout_path: null }), 'hp'),
    remainingDispatchSteps(mkRun(), mkTask({}), 'hp'),
  ]) {
    expect(text).toContain('herdr agent start hp-1 --kind claude')
    expect(text).not.toContain('<name>')
  }
})

test('the worker starts at its tier\'s effort on every path', () => {
  for (const [tier, effort] of [['light', 'medium'], ['standard', 'high'], ['heavy', 'high']] as const) {
    const task = mkTask({ tier })
    for (const text of [
      dispatchSequence(mkRun(), task, FETCHED, { kind: 'none' }, 'hp'),
      startWorkerCommand(mkRun(), task, 'w23', 'hp'),
      dispatchWorkerCommand(mkRun(), { ...task, workspace_id: null }, 'hp'),
      remainingDispatchSteps(mkRun(), task, 'hp'),
    ]) {
      expect(text, tier).toContain(`-- --dangerously-skip-permissions --effort ${effort}`)
    }
  }
})

test('the recovery create is cut from the task\'s base: commit, never main — #121', () => {
  for (const checkout of [null, '/wt']) {
    const text = dispatchWorkerCommand(mkRun(), mkTask({ workspace_id: null, checkout_path: checkout }), 'hp')
    expect(text).toContain('--base <commit>` (the commit on the `base:` line `hp show --task t1` prints, never a base you pick)')
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

test('on the briefed phase with the brief owed, every advice leads with the one command, the manual steps after it', () => {
  const owed = { awaiting_brief: true } as const
  for (const text of [
    startWorkerCommand(mkRun(), mkTask(owed), 'w23', 'hp'),
    dispatchWorkerCommand(mkRun(), mkTask({ ...owed, workspace_id: null, checkout_path: null }), 'hp'),
    remainingDispatchSteps(mkRun(), mkTask(owed), 'hp'),
    remainingDispatchSteps(mkRun(), mkTask({ ...owed, workspace_id: null, checkout_path: null }), 'hp'),
    briefCommand(mkTask(owed), 'w23:p1', 'hp'),
  ]) {
    expect(text).toStartWith('`hp dispatch --task t1` (run it in the background)')
    expect(text.indexOf('`hp dispatch --task t1`')).toBeLessThan(text.indexOf('--pane'))
  }
  expect(briefCommand(mkTask(owed), 'w23:p1', 'hp')).toBe(
    '`hp dispatch --task t1` (run it in the background) hands it over, or by hand `hp dispatch --task t1 --pane w23:p1`')
})

test('a rewind past the briefed phase, or a brief already given, keeps the manual advice', () => {
  for (const text of [
    startWorkerCommand(mkRun(), mkTask({ phase: 'implement' }), 'w23', 'hp'),
    dispatchWorkerCommand(mkRun(), mkTask({ phase: 'implement', workspace_id: null, checkout_path: null }), 'hp'),
    startWorkerCommand(mkRun(), mkTask({}), 'w23', 'hp'),
    dispatchWorkerCommand(mkRun(), mkTask({ workspace_id: null, checkout_path: null }), 'hp'),
  ]) {
    expect(text).not.toContain('`hp dispatch --task t1`')
    expect(text).not.toContain('in the background')
  }
})
