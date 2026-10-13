import { expect, test } from 'bun:test'
import { advanceRun, enterRunPhase, counterFor, type RunSignals } from '../src/lib/machine'
import { newRun, withBatch } from '../src/lib/ledger'
import type { BeforeMergeCheck, Run, RunPhase, Task } from '../src/lib/types'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

function fixture(phase: RunPhase): Run {
  const run = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  enterRunPhase(run, phase, 'test')
  return run
}

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core', depends_on: [], files: [], keep_worktree: false,
  workspace_id: null, pane_id: null, agent_status: 'unknown', phase: 'queued', phase_entered_at: 0,
  escalated_from: null, head_sha_at_entry: null, pr: null, ci: null, checkout_path: null, registered_at: 0,
  adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} }, merged_at_ms: null, ...beadTaskFields(),
  passes: {}, decisions: [], decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', ...over,
})

const signals = (over: Partial<RunSignals> = {}): RunSignals => ({
  actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
  newestRegisteredAt: null, dispatchComplete: false,
  tasksAllTerminal: false, landedTaskCount: 0,
  ...over,
})

test('intake advances on a task registered after phase entry', () => {
  const run = fixture('intake')
  run.phase_entered_at = 1000
  expect(advanceRun(run, signals({ actorIdle: true, newestRegisteredAt: 2000 }))?.phase)
    .toBe('dispatch')
})

test('intake does NOT advance on a task registered before phase entry', () => {
  const run = fixture('intake')
  run.phase_entered_at = 3000
  expect(advanceRun(run, signals({ actorIdle: true, newestRegisteredAt: 2000 }))).toBeNull()
})

test('intake waits while the orchestrator is still registering', () => {
  const run = fixture('intake')
  run.phase_entered_at = 1000
  expect(advanceRun(run, signals({ actorIdle: false, newestRegisteredAt: 2000 }))).toBeNull()
})

test('dispatch advances when every dispatched task is bound', () => {
  const run = fixture('dispatch')
  expect(advanceRun(run, signals({ dispatchComplete: true }))?.phase).toBe('execute')
})

test('dispatch holds while a dispatched task still has no worktree', () => {
  const run = fixture('dispatch')
  expect(advanceRun(run, signals({ dispatchComplete: false }))).toBeNull()
})

test('dispatch does not wait on the orchestrator going idle', () => {
  const run = fixture('dispatch')
  expect(advanceRun(run, signals({ actorIdle: false, dispatchComplete: true }))?.phase)
    .toBe('execute')
})

test('execute waits for intake_closed even when every task is terminal', () => {
  const run = fixture('execute')
  run.intake_closed = false
  expect(advanceRun(run, signals({ tasksAllTerminal: true, landedTaskCount: 2 }))).toBeNull()
})

test('execute goes to branch-review when intake is closed and two tasks landed', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, signals({ tasksAllTerminal: true, landedTaskCount: 2 }))?.phase)
    .toBe('branch-review')
})

test('execute finishes the run without a branch review when exactly one task landed', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, signals({ tasksAllTerminal: true, landedTaskCount: 1 }))?.phase).toBe('done')
  expect(run.history.at(-1)?.why).toBe('one task merged; branch-review skipped')
})

// Smoke run 14 told a per-task run "one task landed" for a merged PR.
test('a per-task run ends naming the one PR that merged; a single-PR run says landed', () => {
  const perTask = fixture('execute')
  perTask.intake_closed = true
  perTask.tasks = [mkTask({ task_id: 't1', phase: 'done', pr: 55, merged_at_ms: 1 })]
  advanceRun(perTask, signals({ tasksAllTerminal: true, landedTaskCount: 1 }))
  expect(perTask.history.at(-1)?.why).toBe('one task merged (PR #55); branch-review skipped')

  const singlePr = withBatch(fixture('execute'), batchFixture())
  singlePr.intake_closed = true
  advanceRun(singlePr, signals({ tasksAllTerminal: true, landedTaskCount: 1 }))
  expect(singlePr.history.at(-1)?.why).toBe('one task landed; branch-review skipped')
})

test('execute escalates when no task landed', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, signals({ tasksAllTerminal: true, landedTaskCount: 0 }))?.phase)
    .toBe('escalated')
})

test('branch-review escalates at MAX_PASSES on its own counter', () => {
  const run = fixture('branch-review')
  const s = signals({
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'BLOCKER' as const, blockers: 1, majors: 0 },
  })
  advanceRun(run, s)
  expect(run.phase).toBe('branch-review')
  expect(counterFor(run, 'branch-review')).toBe(1)
  advanceRun(run, s)
  expect(run.phase).toBe('escalated')
})

test('a per-task execute waits while a merged task still owes a before-merge check', () => {
  const run = fixture('execute')
  run.intake_closed = true
  const check: BeforeMergeCheck = { id: 'c1', check: 'no ghost', recorded_at: 1, recorded_pane: 'w1:p1', resolutions: [] }
  run.tasks = [mkTask({ phase: 'done', merged_at_ms: 1, before_merge: [check] }), mkTask({ task_id: 't2', phase: 'done', merged_at_ms: 1 })]
  const allLanded = signals({ tasksAllTerminal: true, landedTaskCount: 2 })
  expect(advanceRun(run, allLanded)).toBeNull()
  check.resolutions.push({ as: 'waived', at: 2, head: null, note: 'release window', pane: 'w1:p1' })
  expect(advanceRun(run, allLanded)?.phase).toBe('branch-review')
})
