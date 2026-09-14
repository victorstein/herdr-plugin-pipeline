import { expect, test } from 'bun:test'
import { advanceRun, enterRunPhase } from '../src/lib/machine'
import { newRun } from '../src/lib/ledger'
import type { Run } from '../src/lib/types'

const mkRun = (): Run =>
  newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })

test('spec advances to spec-review when the artifact is fresh and the actor is idle', () => {
  const run = mkRun()
  const next = advanceRun(run, { actorIdle: true, artifactFresh: true, verdict: null, maxPasses: 2 })
  expect(next?.phase).toBe('spec-review')
})

test('spec does not advance while the actor is working', () => {
  const run = mkRun()
  expect(advanceRun(run, { actorIdle: false, artifactFresh: true, verdict: null, maxPasses: 2 })).toBeNull()
})

test('spec does not advance without a fresh artifact', () => {
  const run = mkRun()
  expect(advanceRun(run, { actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2 })).toBeNull()
})

test('a CLEAR spec review advances to plan', () => {
  const run = enterRunPhase(mkRun(), 'spec-review', 'test')
  const next = advanceRun(run, {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'CLEAR', blockers: 0, majors: 0 }, maxPasses: 2,
  })
  expect(next?.phase).toBe('plan')
})

test('a BLOCKER spec review returns to spec and increments pass', () => {
  const run = enterRunPhase(mkRun(), 'spec-review', 'test')
  const next = advanceRun(run, {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'BLOCKER', blockers: 1, majors: 0 }, maxPasses: 2,
  })
  expect(next?.phase).toBe('spec')
  expect(next?.pass).toBe(2)
})

test('exhausting MAX_PASSES escalates and records where from', () => {
  const run = enterRunPhase(mkRun(), 'spec-review', 'test')
  run.pass = 2
  const next = advanceRun(run, {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'BLOCKER', blockers: 1, majors: 0 }, maxPasses: 2,
  })
  expect(next?.phase).toBe('escalated')
  expect(next?.escalated_from).toBe('spec-review')
})

test('LIVELOCK: re-entered spec does not re-advance on the stale artifact', () => {
  // The spec file still exists from pass 1, but its mtime predates this phase entry.
  const run = enterRunPhase(mkRun(), 'spec', 'blocker on pass 1')
  expect(advanceRun(run, { actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2 })).toBeNull()
})

test('enterRunPhase stamps phase_entered_at and appends history', () => {
  const before = Date.now() - 1
  const run = enterRunPhase(mkRun(), 'plan', 'spec review cleared')
  expect(run.phase_entered_at).toBeGreaterThan(before)
  expect(run.history.at(-1)).toMatchObject({ to: 'plan', why: 'spec review cleared' })
})
