import { expect, test } from 'bun:test'
import { newRun, withBatch } from '../src/lib/ledger'
import { rowRunsIn, TASK_ROWS } from '../src/lib/phases'
import { actionFor } from '../src/lib/status'
import type { Run, Task } from '../src/lib/types'
import { stallAwaiting, taskStallCandidates } from '../src/supervisor/stall'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

const NOW = 10_000_000
const LONG_AGO = NOW - 60 * 60 * 1000

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core', depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle', phase: 'land-queue', phase_entered_at: LONG_AGO,
  escalated_from: null, head_sha_at_entry: null, pr: null, ci: null, checkout_path: '/r/wt', registered_at: 0,
  adopted_at: 0, artifacts: { research: null, spec: null, plan: null, verdicts: {} }, merged_at_ms: null,
  ...beadTaskFields(), passes: {}, decisions: [], decision_from: null, pending_answer: null, delivery_attempts: 0,
  notes: '', land_sha: '4b1d0e2a99', ...over,
})

function singlePr(tasks: Task[]): Run {
  const run = withBatch(newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: "/code/o'b", title: 'a' }),
    batchFixture())
  run.phase = 'execute'
  run.phase_entered_at = LONG_AGO
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  return run
}

const probed = (run: Run) => taskStallCandidates([run], NOW, 45, 3, 15).map((c) => c.task?.task_id)

test('a task waiting to land is not probed while another holds the slot: the holder has its own ladder', () => {
  const run = singlePr([mkTask({ task_id: 't1', phase: 'sync' }), mkTask({ task_id: 't2' })])
  expect(probed(run)).toEqual(['t1'])
})

test('with no holder, a waiting task is probed, and the clause says the run is not being advanced', () => {
  const run = singlePr([mkTask({ task_id: 't2' })])
  expect(probed(run)).toEqual(['t2'])
  const { clause } = stallAwaiting(run, run.tasks[0]!, 'hp', NOW)
  expect(clause).toContain('No task holds the landing slot')
  expect(clause).toContain('this run is not being advanced')
  expect(clause).toContain("Check the supervisor pane's log")
  expect(clause).toContain('git -C')
})

test('the land-queue clause names a failing fetch of the batch', () => {
  const run = singlePr([mkTask({ task_id: 't2' })])
  run.batch!.fetch_error = { reason: "couldn't find remote ref batch/x", since: NOW - 12 * 60_000 }
  expect(stallAwaiting(run, run.tasks[0]!, 'hp', NOW).clause)
    .toContain("batch/x has not fetched for 12m (couldn't find remote ref batch/x)")
})

test('a paneless task that must sync is told apart, with the command that starts an agent for it', () => {
  const run = singlePr([mkTask({ task_id: 't2', pane_id: null })])
  const { clause } = stallAwaiting(run, run.tasks[0]!, 'hp', NOW)
  expect(clause).toContain('needs an agent in its worktree to sync')
  expect(clause).toContain('herdr agent start')
})

test('sync escalates: it is the worker\'s own work', () => {
  const run = singlePr([mkTask({ phase: 'sync', stall: { at: LONG_AGO, run_at: LONG_AGO, last_probe_at: LONG_AGO, probes: 3, holds: 0 } })])
  expect(taskStallCandidates([run], NOW, 45, 3)[0]?.action).toBe('escalate')
})

test('the sync clause gives both commands and names the tasks waiting on it', () => {
  const run = singlePr([mkTask({ phase: 'sync' }), mkTask({ task_id: 't5' }), mkTask({ task_id: 't6' })])
  const { clause, short } = stallAwaiting(run, run.tasks[0]!, 'hp', NOW)
  expect(short).toBe('batch/x merged into t1-branch, checked and resubmitted')
  expect(clause).toContain('git merge --no-edit origin/batch/x')
  expect(clause).toContain('hp submit --task t1')
  expect(clause).toContain('t5, t6 wait on this sync')
})

test('the single-PR merge clause gives the landing push, and what a refusal means', () => {
  const run = singlePr([mkTask({ phase: 'merge' }), mkTask({ task_id: 't5' })])
  const { clause, short } = stallAwaiting(run, run.tasks[0]!, 'hp', NOW)
  expect(short).toBe('t1-branch at 4b1d0e2a to land on batch/x')
  expect(clause).toContain("git -C '/code/o'\\''b' push origin 4b1d0e2a99:refs/heads/batch/x")
  expect(clause).toContain('If the push is refused for any reason, end your turn')
  expect(clause).toContain("Landing is yours, not the plugin's; nothing lands automatically.")
  expect(clause).toContain('t5 waits on this landing')
  expect(clause).not.toContain('PR number')
})

test('the single-PR implement clause asks for a submission, not a PR', () => {
  const run = singlePr([mkTask({ phase: 'implement' })])
  const { clause, short } = stallAwaiting(run, run.tasks[0]!, 'hp', NOW)
  expect(short).toBe('a submission for t1-branch (hp-1)')
  expect(clause).toContain('hp submit --task t1 --title "<conventional title>"')
  expect(clause).toContain('committed, pushed, checked and not already on batch/x')
})

test('in a single-PR run a move clause names what the stall probe for the same row names — #95', () => {
  for (const row of TASK_ROWS.filter((r) => rowRunsIn(r, 'single-pr'))) {
    if (row.actor !== 'orchestrator' && row.actor !== 'worker') continue
    const task = mkTask({ phase: row.phase, artifacts: { research: 'r.md', spec: 's.md', plan: 'p.md', verdicts: {} } })
    const run = singlePr([task])
    expect(actionFor(run, task, 'hp', NOW), row.phase).toEndWith(`waiting for ${stallAwaiting(run, task, 'hp', NOW).short}`)
  }
})

test('the ship rows have clauses of their own, and only ship escalates', () => {
  const ship = singlePr([])
  ship.phase = 'ship'
  expect(stallAwaiting(ship, null, 'hp', NOW)).toMatchObject({ short: 'the batch PR, opened at a checked head' })
  expect(stallAwaiting(ship, null, 'hp', NOW).clause).toContain('hp batch-check')

  const ci = singlePr([])
  ci.phase = 'ship-ci'
  ci.batch!.pr = 301
  expect(stallAwaiting(ci, null, 'hp', NOW).clause).toContain('gh pr checks 301')

  const merging = singlePr([])
  merging.phase = 'ship-merge'
  merging.batch!.pr = 301
  const { clause } = stallAwaiting(merging, null, 'hp', NOW)
  expect(clause).toContain('squash-merge PR #301')
  expect(clause).toContain('gh pr update-branch 301')
  expect(clause).toContain(`hp rewind ${merging.run_id} ship`)
  expect(clause).toContain('no other `hp start` can begin here')
})
