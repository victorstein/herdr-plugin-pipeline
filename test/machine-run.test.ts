import { expect, test } from 'bun:test'
import { advanceRun, enterRunPhase, counterFor } from '../src/lib/machine'
import { newRun } from '../src/lib/ledger'
import type { Run, RunPhase } from '../src/lib/types'

function fixture(phase: RunPhase): Run {
  const run = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  enterRunPhase(run, phase, 'test')
  return run
}

test('intake advances on a task registered after phase entry', () => {
  const run = fixture('intake')
  run.phase_entered_at = 1000
  expect(advanceRun(run, {
    actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: 2000, newestAdoptedAt: null, tasksAllTerminal: false,
    anyTaskDone: false,
  })?.phase).toBe('dispatch')
})

test('intake does NOT advance on a task registered before phase entry', () => {
  const run = fixture('intake')
  run.phase_entered_at = 3000
  expect(advanceRun(run, {
    actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: 2000, newestAdoptedAt: null, tasksAllTerminal: false,
    anyTaskDone: false,
  })).toBeNull()
})

test('execute waits for intake_closed even when every task is terminal', () => {
  const run = fixture('execute')
  run.intake_closed = false
  expect(advanceRun(run, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: null, newestAdoptedAt: null,
    tasksAllTerminal: true, anyTaskDone: true,
  })).toBeNull()
})

test('execute goes to branch-review when intake is closed and a task is done', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: null, newestAdoptedAt: null,
    tasksAllTerminal: true, anyTaskDone: true,
  })?.phase).toBe('branch-review')
})

test('execute escalates when no task reached done', () => {
  const run = fixture('execute')
  run.intake_closed = true
  expect(advanceRun(run, {
    actorIdle: false, artifactFresh: false, verdict: null, maxPasses: 2,
    newestRegisteredAt: null, newestAdoptedAt: null,
    tasksAllTerminal: true, anyTaskDone: false,
  })?.phase).toBe('escalated')
})

test('branch-review escalates at MAX_PASSES on its own counter', () => {
  const run = fixture('branch-review')
  const s = {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'BLOCKER' as const, blockers: 1, majors: 0 }, maxPasses: 2,
    newestRegisteredAt: null, newestAdoptedAt: null,
    tasksAllTerminal: false, anyTaskDone: false,
  }
  advanceRun(run, s)
  expect(run.phase).toBe('branch-review')
  expect(counterFor(run, 'branch-review')).toBe(1)
  advanceRun(run, s)
  expect(run.phase).toBe('escalated')
})
