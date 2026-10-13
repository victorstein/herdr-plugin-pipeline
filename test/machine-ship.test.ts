import { expect, test } from 'bun:test'
import { advanceRun, counterFor, enterRunPhase, type RunSignals } from '../src/lib/machine'
import { newRun, withBatch } from '../src/lib/ledger'
import type { Batch, Run, RunPhase } from '../src/lib/types'
import { batchFixture } from './helpers/batch'

function fixture(phase: RunPhase, batch: Partial<Batch> = {}): Run {
  const run = withBatch(newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' }),
    batchFixture(batch))
  enterRunPhase(run, phase, 'test')
  return run
}

const signals = (over: Partial<RunSignals> = {}): RunSignals => ({
  actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2,
  newestRegisteredAt: null, dispatchComplete: false, tasksAllTerminal: false, landedTaskCount: 0, ...over,
})

const pr = (over: Partial<NonNullable<RunSignals['batchPr']>> = {}): NonNullable<RunSignals['batchPr']> => ({
  number: 301, headSha: 'h1', merged: false, mergedAtMs: null, mergeCommit: null, ...over,
})

test('execute with one landing ships a single-PR run, and ends a per-task one', () => {
  const singlePr = fixture('execute')
  singlePr.intake_closed = true
  expect(advanceRun(singlePr, signals({ tasksAllTerminal: true, landedTaskCount: 1 }))?.phase).toBe('ship')
  const perTask = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  enterRunPhase(perTask, 'execute', 'test')
  perTask.intake_closed = true
  expect(advanceRun(perTask, signals({ tasksAllTerminal: true, landedTaskCount: 1 }))?.phase).toBe('done')
})

test('a cleared branch review ships a single-PR run', () => {
  const run = fixture('branch-review')
  const verdict = { verdict: 'CLEAR' as const, blockers: 0, majors: 0 }
  expect(advanceRun(run, signals({ artifactFresh: true, verdict }))?.phase).toBe('ship')
})

test('ship clears once the PR is found at a head that moved and was checked, and records the PR', () => {
  const run = fixture('ship', { checked: { head_sha: 'h1', at: 1, check: 'passed' } })
  expect(advanceRun(run, signals({ batchPr: null }))).toBeNull()
  expect(advanceRun(run, signals({ actorIdle: false, batchPr: pr() }))).toBeNull()
  expect(run.batch?.pr).toBe(301)
  expect(advanceRun(run, signals({ batchPr: pr() }))?.phase).toBe('ship-ci')
  expect(run.batch?.pr).toBe(301)
})

test('ship waits for a check of the PR\'s own head, and for a head past the one CI failed on', () => {
  const unchecked = fixture('ship', { checked: { head_sha: 'h0', at: 1, check: 'passed' } })
  expect(advanceRun(unchecked, signals({ batchPr: pr() }))).toBeNull()
  expect(unchecked.batch?.pr).toBe(301)
  const unmoved = fixture('ship', { head_sha_at_entry: 'h1', checked: { head_sha: 'h1', at: 1, check: 'none' } })
  expect(advanceRun(unmoved, signals({ batchPr: pr() }))).toBeNull()
})

test('entering ship-ci forgets the last bucket, and the head it was read on', () => {
  const run = fixture('ship', {
    ci: 'fail', ci_head: { sha: 'h0', seen_at: 0 }, head_sha_at_entry: 'h0',
    checked: { head_sha: 'h1', at: 1, check: 'passed' },
  })
  expect(advanceRun(run, signals({ batchPr: pr() }))?.phase).toBe('ship-ci')
  expect(run.batch?.ci).toBeNull()
  expect(run.batch?.ci_head).toBeUndefined()
  expect(advanceRun(run, signals())).toBeNull()
})

const checkedAt = (head_sha: string) => ({ checked: { head_sha, at: 1, check: 'passed' as const } })

// Smoke run 16: an empty commit pushed during ship-merge went ship-ci → ship-merge and merged at a head
// batch-check never recorded, though ship.md says the PR clears only on the head it recorded.
test('a head CI was read on past the one batch-check recorded sends ship-ci back to ship, green or not', () => {
  for (const ci of ['pending', 'pass'] as const) {
    const run = fixture('ship-ci', { pr: 301, ...checkedAt('h1') })
    run.batch!.ci = ci
    run.batch!.ci_head = { sha: 'h2', seen_at: 0 }
    expect(advanceRun(run, signals({ actorIdle: false }))?.phase, ci).toBe('ship')
    expect(run.history.at(-1)?.why).toBe('head moved to h2 past h1, the head batch-check recorded')
    expect(counterFor(run, 'ship-ci')).toBe(0)
  }
})

test('a red on a moved head is still the PR\'s red: it spends the repair, from the head it failed on', () => {
  const run = fixture('ship-ci', { pr: 301, ...checkedAt('h1') })
  run.batch!.ci = 'fail'
  run.batch!.ci_head = { sha: 'h2', seen_at: 0 }
  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h2' }) }))?.phase).toBe('ship')
  expect(counterFor(run, 'ship-ci')).toBe(1)
  expect(run.batch?.head_sha_at_entry).toBe('h2')
})

test('ship-ci passes to ship-merge, and a red one goes back to ship once, from the head it failed on', () => {
  const green = fixture('ship-ci', { pr: 301 })
  green.batch!.ci = 'pass'
  expect(advanceRun(green, signals({ actorIdle: false }))?.phase).toBe('ship-merge')

  const red = fixture('ship-ci', { pr: 301 })
  red.batch!.ci = 'fail'
  expect(advanceRun(red, signals({ batchPr: null }))).toBeNull()
  expect(advanceRun(red, signals({ batchPr: pr({ headSha: 'h2' }) }))?.phase).toBe('ship')
  expect(red.batch?.head_sha_at_entry).toBe('h2')
  expect(counterFor(red, 'ship-ci')).toBe(1)
})

test('a second red escalates the run: the batch PR gets one repair', () => {
  const run = fixture('ship-ci', { pr: 301 })
  run.passes['ship-ci'] = 1
  run.batch!.ci = 'fail'
  expect(advanceRun(run, signals({ batchPr: null }))?.phase).toBe('escalated')
  expect(run.escalated_from).toBe('ship-ci')
})

test('ship-merge records the merge and ends the run', () => {
  const run = fixture('ship-merge', { pr: 301, ci_head: { sha: 'h1', seen_at: 0 } })
  const next = advanceRun(run, signals({ batchPr: pr({ merged: true, mergedAtMs: 5_000, mergeCommit: 'm1' }) }))
  expect(next?.phase).toBe('done')
  expect(run.batch).toMatchObject({ merged_at_ms: 5_000, merge_commit: 'm1' })
  expect(run.history.at(-1)?.why).toBe('PR #301 squash-merged as m1')
})

test('a head that moves after CI passed sends ship-merge back to ship, to be checked before CI', () => {
  const run = fixture('ship-merge', { pr: 301, ci_head: { sha: 'h1', seen_at: 0 }, ...checkedAt('h1') })
  expect(advanceRun(run, signals({ batchPr: pr() }))).toBeNull()
  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h3' }) }))?.phase).toBe('ship')
  expect(run.history.at(-1)?.why).toBe('head moved to h3 past h1, the head batch-check recorded')

  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h3' }) }))).toBeNull()
  run.batch!.checked = { head_sha: 'h3', at: 2, check: 'passed' }
  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h3' }) }))?.phase).toBe('ship-ci')
  expect(counterFor(run, 'ship-ci')).toBe(0)
})

test('a moved head batch-check already recorded sends ship-merge straight back to ship-ci', () => {
  const run = fixture('ship-merge', { pr: 301, ci_head: { sha: 'h1', seen_at: 0 }, ...checkedAt('h3') })
  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h3' }) }))?.phase).toBe('ship-ci')
  expect(run.history.at(-1)?.why).toBe('head moved to h3 after CI passed on h1')
})

const shipCheck = (resolutions: NonNullable<Run['before_merge']>[number]['resolutions'] = []) =>
  ({ id: 'c1', check: 'the menu closes on a long press', recorded_at: 1, recorded_pane: 'w1:p1', resolutions })

test('a batch PR merged while a check is owed is recorded once, with no transition, and never read for its head again', () => {
  const run = fixture('ship-merge', { pr: 301, ci_head: { sha: 'h1', seen_at: 0 }, ...checkedAt('h1') })
  run.before_merge = [shipCheck()]
  const merged = pr({ merged: true, mergedAtMs: 5_000, mergeCommit: 'm1' })
  expect(advanceRun(run, signals({ batchPr: merged }))).toBeNull()
  expect(run.phase).toBe('ship-merge')
  expect(run.batch).toMatchObject({ merged_at_ms: 5_000, merge_commit: 'm1' })
  const historyLength = run.history.length

  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h9', merged: true, mergedAtMs: 6_000 }) }))).toBeNull()
  expect(advanceRun(run, signals({ batchPr: null }))).toBeNull()
  expect(run.history).toHaveLength(historyLength)
  expect(run.batch?.merged_at_ms).toBe(5_000)

  run.before_merge = [shipCheck([{ as: 'confirmed', at: 2, head: 'h1', pane: 'w1:p1' }])]
  expect(advanceRun(run, signals({ batchPr: null }))?.phase).toBe('done')
  expect(run.history.at(-1)?.why).toBe('PR #301 squash-merged as m1')
})

test('a fix landed on the batch moves the gate head, so a confirmation of the old one is owed again', () => {
  const run = fixture('ship-merge', { pr: 301, ci_head: { sha: 'h1', seen_at: 0 }, ...checkedAt('h1') })
  run.before_merge = [shipCheck([{ as: 'confirmed', at: 2, head: 'h1', pane: 'w1:p1' }])]
  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h2' }) }))?.phase).toBe('ship')
  run.batch!.checked = { head_sha: 'h2', at: 3, check: 'passed' }
  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h2' }) }))?.phase).toBe('ship-ci')
  run.batch!.ci = 'pass'
  run.batch!.ci_head = { sha: 'h2', seen_at: 4 }
  expect(advanceRun(run, signals())?.phase).toBe('ship-merge')
  expect(advanceRun(run, signals({ batchPr: pr({ headSha: 'h2', merged: true, mergedAtMs: 9 }) }))).toBeNull()
  expect(run.phase).toBe('ship-merge')
})
