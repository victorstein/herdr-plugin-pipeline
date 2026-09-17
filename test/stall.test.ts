import { expect, test } from 'bun:test'
import {
  bumpStall, sendProbes, stallAwaiting, stallCandidates, stallStateFor, taskStallCandidates,
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

test('an artifact row names a real absolute path and says how to fix a misfile', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'research', checkout_path: '/wt' })
  task.artifacts.research = 'docs/superpowers/research/r.md'
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp')
  expect(a.clause).toContain('/wt/docs/superpowers/research/r.md')
  expect(a.clause).toContain('Nothing has appeared at')
  expect(a.short).toBe('its research/spec/plan artifact')
})

test('a verdict row shares the path branch but not the short form', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'spec-review', checkout_path: '/wt' })
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp')
  expect(a.short).toBe('its review verdict')
  expect(a.clause).toContain('/wt/docs/superpowers/reviews/')
})

test('a run verdict row resolves against the repo root, not a worktree', () => {
  const run = runAt('branch-review', LONG_AGO)
  const a = stallAwaiting(run, null, 'hp')
  expect(a.short).toBe('its review verdict')
  expect(a.clause).toContain('/r/docs/superpowers/reviews/')
})

test('a pr row names the PR, never a path — the defect the issue addendum raised', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', branch: 'fix/x', issue: 38 })
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp')
  expect(a.clause).toBe('This phase is waiting for a pushed PR for fix/x (#38).')
  expect(a.clause).not.toContain('appeared at')
  expect(a.clause).not.toContain('path above')
})

test('run dispatch waits on a worktree, and never names a reviews path', () => {
  const a = stallAwaiting(runAt('dispatch', LONG_AGO), null, 'hp')
  expect(a.clause).toBe(
    'This phase is waiting for a worktree to be adopted for a dispatched task.')
  expect(a.clause).not.toContain('docs/superpowers/reviews')
})

test('run execute names the rendered hpipe command, never a raw placeholder', () => {
  const a = stallAwaiting(runAt('execute', LONG_AGO), null, 'bun run /p/src/cli.ts')
  expect(a.clause).toBe(
    'This phase is waiting for `bun run /p/src/cli.ts dispatch --done` to close intake.')
  expect(a.clause).not.toContain('{{')
})

test('the blocked rows name the exit, not the symptom', () => {
  const run = runAt('execute', LONG_AGO)
  const files = mkTask({ phase: 'blocked-on-files' })
  const decision = mkTask({ task_id: 't2', phase: 'blocked-on-decision' })
  const teardown = mkTask({ task_id: 't3', phase: 'teardown' })
  run.tasks = [files, decision, teardown]
  expect(stallAwaiting(run, files, 'hp')).toEqual({
    short: 'the files another task holds',
    clause: 'This phase is waiting for another task to release the files this one declared.',
  })
  expect(stallAwaiting(run, decision, 'hp').short).toBe('an answer to the open decision')
  expect(stallAwaiting(run, teardown, 'hp').short).toBe('its worktree to be removed')
})

test('an unrecognised signal falls back to naming the phase', () => {
  const run = runAt('execute', LONG_AGO)
  const ci = mkTask({ phase: 'ci' })
  run.tasks = [ci]
  expect(stallAwaiting(run, ci, 'hp')).toEqual({
    short: 'whatever clears ci',
    clause: 'This phase is waiting for whatever clears ci.',
  })
})
