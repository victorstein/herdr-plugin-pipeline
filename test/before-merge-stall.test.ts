import { expect, test } from 'bun:test'
import { awaitedFor } from '../src/lib/awaiting'
import { freshLadder } from '../src/lib/unstarted'
import type { Run } from '../src/lib/types'
import { stallAwaiting, stallCandidates, taskStallCandidates } from '../src/supervisor/stall'
import { CHECKED_HEAD, checkOf, heldTask, perTaskRun, ruling, singlePrRun } from './helpers/before-merge'

const NOW = 100 * 60 * 60_000
const LONG_AGO = NOW - 10 * 60 * 60_000
const HPIPE = 'hp'

function heldMerge(over: Parameters<typeof heldTask>[0] = {}): Run {
  const run = perTaskRun([heldTask({ phase_entered_at: LONG_AGO, before_merge: [checkOf('c1')], ...over })])
  run.phase_entered_at = LONG_AGO
  return run
}

function heldShip(resolutions: Parameters<typeof checkOf>[1] = []): Run {
  const run = singlePrRun([])
  run.phase_entered_at = LONG_AGO
  run.before_merge = [checkOf('c1', resolutions)]
  return run
}

test('a merge held for the human draws no probe, however long it is open, merged or not', () => {
  expect(taskStallCandidates([heldMerge()], NOW, 45, 3)).toEqual([])
  expect(taskStallCandidates([heldMerge({ merged_at_ms: LONG_AGO })], NOW, 45, 3)).toEqual([])
  expect(stallCandidates([heldShip()], NOW, 15, 3)).toEqual([])
})

test('once nothing is owed, the gate is probed again', () => {
  const confirmed = [ruling('confirmed', CHECKED_HEAD)]
  expect(taskStallCandidates([heldMerge({ before_merge: [checkOf('c1', confirmed)] })], NOW, 45, 3)).toHaveLength(1)
  expect(stallCandidates([heldShip(confirmed)], NOW, 15, 3)).toHaveLength(1)
})

test('a ladder re-armed by the last ruling probes a full threshold later, not on the next tick', () => {
  const run = heldShip([ruling('confirmed', CHECKED_HEAD)])
  run.stall = freshLadder(run, run, NOW)
  expect(stallCandidates([run], NOW + 60_000, 15, 3)).toEqual([])
  expect(stallCandidates([run], NOW + 15 * 60_000, 15, 3)).toHaveLength(1)
})

test('a single-PR check waiting on a fix is the orchestrator\'s move, and its probe names both routes', () => {
  const run = heldShip([ruling('failed', CHECKED_HEAD, 'the menu stays open')])
  const [candidate] = stallCandidates([run], NOW, 15, 3)
  expect(candidate).toBeDefined()
  const awaiting = stallAwaiting(run, null, HPIPE)
  expect(awaiting.short).toBe('a fix for c1, which failed on 9e06c261')
  expect(awaiting.clause).toContain('c1 failed on 9e06c261: the menu stays open.')
  expect(awaiting.clause).toContain('`hp batch-check`, or a fix task through `hp task …`')
  expect(awaiting.clause).not.toContain('gh pr merge')
})

test('no probe text says to merge while a check is owed', () => {
  const forms = [
    stallAwaiting(heldMerge(), heldMerge().tasks[0]!, HPIPE),
    stallAwaiting(heldMerge({ merged_at_ms: 5 }), heldMerge({ merged_at_ms: 5 }).tasks[0]!, HPIPE),
    stallAwaiting(heldShip(), null, HPIPE),
  ]
  for (const { clause } of forms) {
    expect(clause).not.toContain('merge it')
    expect(clause).not.toContain('gh pr merge')
    expect(clause).not.toContain('squash-merge')
  }
  expect(forms[0]!.clause).toBe("This phase waits on the human's check c1 before PR #255 merges, and PR #255 must not " +
    'be merged until they rule. When they answer: `hp confirm --check c1 --by human`, or with ' +
    '`--waive "<why>"` or `--failed "<what they saw>"`.')
  expect(forms[1]!.clause).toBe('PR #255 merged before the human confirmed c1. This task waits here until c1 is ' +
    'confirmed or waived; there is nothing to merge.')
})

test('what a held merge waits for reads the same in status and the digest', () => {
  const held = heldMerge()
  expect(awaitedFor(held, held.tasks[0]!)).toBe("the human's check c1 before PR #255 merges")
  const merged = heldMerge({ merged_at_ms: 5 })
  expect(awaitedFor(merged, merged.tasks[0]!)).toBe("the human's check c1; PR #255 merged before it was confirmed")
})
