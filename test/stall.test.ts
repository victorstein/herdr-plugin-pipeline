import { expect, test } from 'bun:test'
import {
  bumpStall, sendProbes, stallCandidates, stallStateFor, taskStallCandidates,
} from '../src/supervisor/stall'
import { newRun } from '../src/lib/ledger'
import type { Run, RunPhase, Task } from '../src/lib/types'

const ORCHESTRATOR_PANE = 'w1:p1'

function runAt(phase: RunPhase, enteredAt: number): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = phase
  run.phase_entered_at = enteredAt
  run.orchestrator_pane = ORCHESTRATOR_PANE
  return run
}

const NOW = 1_000_000
// Past both the run-level (15 min) and task-level (45 min) thresholds under test.
const LONG_AGO = NOW - 60 * 60 * 1000

test('a verdict phase open past the threshold is a candidate', () => {
  expect(stallCandidates([runAt('branch-review', LONG_AGO)], NOW, 15, new Set())).toHaveLength(1)
})

test('execute is probed once every task is terminal but intake was never closed', () => {
  const run = runAt('execute', LONG_AGO)
  run.intake_closed = false
  run.tasks = [mkTask({ phase: 'done' })]
  const out = stallCandidates([run], NOW, 15, new Set())
  expect(out.map((c) => c.paneId)).toEqual([ORCHESTRATOR_PANE])
})

test('a healthy execute with work still running is NOT probed', () => {
  // v4's third review round removed exactly this false alarm: a six-worker run
  // would otherwise be probed 15 minutes in, while the orchestrator is busiest.
  const run = runAt('execute', LONG_AGO)
  run.intake_closed = false
  run.tasks = [mkTask({ phase: 'implement' }), mkTask({ task_id: 't2', phase: 'done' })]
  expect(stallCandidates([run], NOW, 15, new Set())).toHaveLength(0)
})

test('execute is not probed once intake is properly closed', () => {
  const run = runAt('execute', LONG_AGO)
  run.intake_closed = true
  run.tasks = [mkTask({ phase: 'done' })]
  expect(stallCandidates([run], NOW, 15, new Set())).toHaveLength(0)
})

test('dispatch is probed via the orchestrator too — its row is stallable', () => {
  const run = runAt('dispatch', LONG_AGO)
  expect(stallCandidates([run], NOW, 15, new Set()).map((c) => c.paneId))
    .toEqual([ORCHESTRATOR_PANE])
})

test('a run phase whose row is not stallable is never a candidate', () => {
  for (const phase of ['intake', 'escalated', 'done'] as const) {
    expect(stallCandidates([runAt(phase, LONG_AGO)], NOW, 15, new Set())).toHaveLength(0)
  }
})

test('a phase within the threshold is not a candidate', () => {
  expect(stallCandidates([runAt('branch-review', NOW - 60_000)], NOW, 15, new Set())).toHaveLength(0)
})

test('a phase already probed is not probed again', () => {
  const run = runAt('branch-review', LONG_AGO)
  const probed = new Set([`${run.run_id}:branch-review:${run.phase_entered_at}`])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(0)
})

test('re-entering the same phase makes it probeable again', () => {
  const run = runAt('branch-review', LONG_AGO)
  const probed = new Set([`${run.run_id}:branch-review:12345`])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(1)
})

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
  phase: 'implement', phase_entered_at: LONG_AGO, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function runWithTasks(tasks: Task[]): Run {
  const run = runAt('execute', NOW)
  run.tasks = tasks
  return run
}

const runWithTask = (over: Partial<Task>): Run =>
  runWithTasks([mkTask({ phase_entered_at: LONG_AGO, ...over })])

test('a task sitting in implement past the threshold with no PR is a candidate', () => {
  const run = runWithTasks([mkTask({})])
  expect(taskStallCandidates([run], NOW, 45, new Set())).toHaveLength(1)
})

test('a task that re-entered implement with an open PR is still probed', () => {
  // Re-entry from a blocker review or red CI: the PR exists and head_sha_at_entry
  // is the rejected sha, so a silent worker would otherwise never be noticed.
  const run = runWithTasks([mkTask({ pr: 42, head_sha_at_entry: 'rejected' })])
  expect(taskStallCandidates([run], NOW, 45, new Set())).toHaveLength(1)
})

test('a task inside the threshold is not a candidate', () => {
  const run = runWithTasks([mkTask({ phase_entered_at: NOW - 60_000 })])
  expect(taskStallCandidates([run], NOW, 45, new Set())).toHaveLength(0)
})

test('a task phase whose row is not stallable is never probed', () => {
  for (const phase of ['queued', 'ci', 'merge', 'close', 'teardown', 'done'] as const) {
    const run = runWithTasks([mkTask({ phase })])
    expect(taskStallCandidates([run], NOW, 45, new Set())).toHaveLength(0)
  }
})

test('a task already probed for this phase entry is not probed again', () => {
  const run = runWithTasks([mkTask({})])
  const probed = new Set([`${run.run_id}:t1:implement:${LONG_AGO}`])
  expect(taskStallCandidates([run], NOW, 45, probed)).toHaveLength(0)
})

test('a task stranded in blocked-on-files is probed via the orchestrator', () => {
  const run = runWithTask({ phase: 'blocked-on-files', pane_id: null })
  const out = taskStallCandidates([run], NOW, 15, new Set())
  expect(out).toHaveLength(1)
  expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
})

test('a task waiting in blocked-on-decision is probed via the orchestrator', () => {
  const run = runWithTask({ phase: 'blocked-on-decision', pane_id: 'w7:p1' })
  const out = taskStallCandidates([run], NOW, 15, new Set())
  expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
})

test('a worker-owned artifact row is probed via the worker pane', () => {
  const run = runWithTask({ phase: 'spec', pane_id: 'w7:p1' })
  const out = taskStallCandidates([run], NOW, 15, new Set())
  expect(out[0]?.paneId).toBe('w7:p1')
})

test('a worker row with no pane falls back to the orchestrator', () => {
  const run = runWithTask({ phase: 'research', pane_id: null })
  const out = taskStallCandidates([run], NOW, 15, new Set())
  expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
})

test('a probe that could not be sent stays eligible on the next tick', async () => {
  const run = runAt('branch-review', LONG_AGO)
  const probed = new Set<string>()

  await sendProbes(stallCandidates([run], NOW, 15, probed), probed, async () => ({ ok: false }))
  expect([...probed]).toEqual([])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(1)

  await sendProbes(stallCandidates([run], NOW, 15, probed), probed, async () => ({ ok: true }))
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(0)
})

test('a run with no orchestrator pane is left pending, not marked probed', async () => {
  const run = runAt('branch-review', LONG_AGO)
  run.orchestrator_pane = null
  const probed = new Set<string>()

  await sendProbes(stallCandidates([run], NOW, 15, probed), probed, async () => ({ ok: true }))
  expect([...probed]).toEqual([])

  run.orchestrator_pane = ORCHESTRATOR_PANE
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(1)
})

test('stall state reads as zero when absent, anchored at the later phase entry', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  expect(stallStateFor(run, task)).toEqual({
    at: 900, run_at: 500, last_probe_at: 900, probes: 0, holds: 0,
  })
})

test('the anchor is the LATER of the two entries — a run phase change re-arms the task', () => {
  const run = runAt('branch-review', 9000)
  const task = mkTask({ phase_entered_at: 900 })
  expect(stallStateFor(run, task).last_probe_at).toBe(9000)
})

test('a stall state whose record stamp is stale reads as zero', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  task.stall = { at: 111, run_at: 500, last_probe_at: 111, probes: 3, holds: 0 }
  expect(stallStateFor(run, task).probes).toBe(0)
})

test('a stall state whose RUN stamp is stale reads as zero', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  task.stall = { at: 900, run_at: 222, last_probe_at: 900, probes: 3, holds: 0 }
  expect(stallStateFor(run, task).probes).toBe(0)
})

test('a stall state with both stamps matching is returned as stored', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  task.stall = { at: 900, run_at: 500, last_probe_at: 1234, probes: 2, holds: 1 }
  expect(stallStateFor(run, task)).toEqual(task.stall)
})

test('a bump rewrites both stamps, or the next read would reject it', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  bumpStall(run, task, 'probes', 5000)
  expect(task.stall).toEqual({
    at: 900, run_at: 500, last_probe_at: 5000, probes: 1, holds: 0,
  })
  expect(stallStateFor(run, task).probes).toBe(1)
})

test('bumps accumulate, and holds and probes count separately', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  bumpStall(run, task, 'probes', 1000)
  bumpStall(run, task, 'probes', 2000)
  bumpStall(run, task, 'holds', 3000)
  expect(stallStateFor(run, task)).toEqual({
    at: 900, run_at: 500, last_probe_at: 3000, probes: 2, holds: 1,
  })
})

test('a bump on a stale state replaces it rather than incrementing it', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  task.stall = { at: 111, run_at: 500, last_probe_at: 111, probes: 7, holds: 7 }
  bumpStall(run, task, 'probes', 4000)
  expect(stallStateFor(run, task).probes).toBe(1)
  expect(stallStateFor(run, task).holds).toBe(0)
})
