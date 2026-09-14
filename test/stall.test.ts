import { expect, test } from 'bun:test'
import { stallCandidates, taskStallCandidates } from '../src/supervisor/stall'
import { newRun } from '../src/lib/ledger'
import type { Run, RunPhase, Task } from '../src/lib/types'

function runAt(phase: RunPhase, enteredAt: number): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = phase
  run.phase_entered_at = enteredAt
  run.orchestrator_pane = 'w1:p1'
  return run
}

const NOW = 1_000_000
// Past both the run-level (15 min) and task-level (45 min) thresholds under test.
const LONG_AGO = NOW - 60 * 60 * 1000

test('an artifact phase open past the threshold is a candidate', () => {
  expect(stallCandidates([runAt('spec', LONG_AGO)], NOW, 15, new Set())).toHaveLength(1)
})

test('execute is NEVER a stall candidate — it has no artifact by design', () => {
  expect(stallCandidates([runAt('execute', LONG_AGO)], NOW, 15, new Set())).toHaveLength(0)
})

test('dispatch is not a candidate either', () => {
  expect(stallCandidates([runAt('dispatch', LONG_AGO)], NOW, 15, new Set())).toHaveLength(0)
})

test('a phase within the threshold is not a candidate', () => {
  expect(stallCandidates([runAt('spec', NOW - 60_000)], NOW, 15, new Set())).toHaveLength(0)
})

test('a phase already probed is not probed again', () => {
  const run = runAt('spec', LONG_AGO)
  const probed = new Set([`${run.run_id}:spec:${run.phase_entered_at}`])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(0)
})

test('re-entering the same phase makes it probeable again', () => {
  const run = runAt('spec', LONG_AGO)
  const probed = new Set([`${run.run_id}:spec:12345`])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(1)
})

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
  phase: 'execute', pass: 1, phase_entered_at: LONG_AGO, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null, ...over,
})

function runWithTasks(tasks: Task[]): Run {
  const run = runAt('execute', NOW)
  run.tasks = tasks
  return run
}

test('a task sitting in execute past the threshold with no PR is a candidate', () => {
  const run = runWithTasks([mkTask({})])
  expect(taskStallCandidates([run], NOW, 45, new Set())).toHaveLength(1)
})

test('a task that already opened a PR is not stalled', () => {
  const run = runWithTasks([mkTask({ pr: 42 })])
  expect(taskStallCandidates([run], NOW, 45, new Set())).toHaveLength(0)
})

test('a task inside the threshold is not a candidate', () => {
  const run = runWithTasks([mkTask({ phase_entered_at: NOW - 60_000 })])
  expect(taskStallCandidates([run], NOW, 45, new Set())).toHaveLength(0)
})

test('only execute is probed — review and merge phases are orchestrator-owned', () => {
  for (const phase of ['task-review-spec', 'merge', 'close', 'queued'] as const) {
    const run = runWithTasks([mkTask({ phase })])
    expect(taskStallCandidates([run], NOW, 45, new Set())).toHaveLength(0)
  }
})

test('a task already probed for this phase entry is not probed again', () => {
  const run = runWithTasks([mkTask({})])
  const probed = new Set([`${run.run_id}:t1:execute:${LONG_AGO}`])
  expect(taskStallCandidates([run], NOW, 45, probed)).toHaveLength(0)
})
