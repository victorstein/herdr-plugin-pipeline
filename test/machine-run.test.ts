import { expect, test } from 'bun:test'
import { advanceRun, enterRunPhase, counterFor, type RunSignals } from '../src/lib/machine'
import { newRun } from '../src/lib/ledger'
import type { Run, RunPhase } from '../src/lib/types'

function fixture(phase: RunPhase): Run {
  const run = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  enterRunPhase(run, phase, 'test')
  return run
}

const signals = (over: Partial<RunSignals> = {}): RunSignals => ({
  actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
  newestRegisteredAt: null, dispatchComplete: false,
  tasksAllTerminal: false, anyTaskDone: false,
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
  expect(advanceRun(run, signals({ tasksAllTerminal: true, anyTaskDone: true }))).toBeNull()
})

test('execute goes to branch-review when intake is closed and a task is done', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, signals({ tasksAllTerminal: true, anyTaskDone: true }))?.phase)
    .toBe('branch-review')
})

test('execute escalates when no task reached done', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, signals({ tasksAllTerminal: true, anyTaskDone: false }))?.phase)
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
