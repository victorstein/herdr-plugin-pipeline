import { expect, test } from 'bun:test'
import type { ExportedBead } from '../src/lib/bd'
import { AWAITING_HUMAN_LABEL, desiredBead, RUN_METADATA_KEY } from '../src/lib/bead-desired'
import type { Run } from '../src/lib/types'
import { callsFor, closeReason, syncBeads } from '../src/supervisor/beads-sync'
import { CHECKED_HEAD, checkOf, heldTask, perTaskRun, ruling, singlePrRun } from './helpers/before-merge'

const bead = (over: Partial<ExportedBead> = {}): ExportedBead =>
  ({ id: 'hp-1', title: 'hp-1', status: 'open', labels: [], dependencies: [], comments: [], ...over })

const MARKER = '[hpipe t1/c1/before-merge]'

function held(over: Parameters<typeof heldTask>[0] = {}): Run {
  const run = perTaskRun([heldTask({ before_merge: [checkOf('c1', [], { decision: 'd1' })], ...over })])
  run.run_id = 'r1'
  return run
}

test('a held task\'s bead shows it blocked on the human, merged or not, and never closed', () => {
  for (const merged_at_ms of [null, 5]) {
    const run = held({ merged_at_ms })
    expect(desiredBead(run.tasks[0]!, run), String(merged_at_ms)).toMatchObject({
      status: 'blocked', assignee: 'hpipe', labels: ['merge', AWAITING_HUMAN_LABEL],
    })
  }
})

test('once nothing is owed, or the run is driving nothing, the merged task\'s bead closes as usual', () => {
  const confirmed = held({ merged_at_ms: 5, before_merge: [checkOf('c1', [ruling('confirmed', CHECKED_HEAD)])] })
  expect(desiredBead(confirmed.tasks[0]!, confirmed).status).toBe('closed')
  for (const phase of ['done', 'escalated'] as const) {
    const parked = held({ merged_at_ms: 5 })
    parked.phase = phase
    expect(desiredBead(parked.tasks[0]!, parked).status, phase).toBe('closed')
  }
})

test('the check and each ruling are posted once, in the bead\'s marker shape', () => {
  const run = held({ before_merge: [checkOf('c1', [
    ruling('failed', CHECKED_HEAD, 'a ghost on page 3'), ruling('confirmed', CHECKED_HEAD), ruling('waived', null, 'ok'),
  ], { decision: 'd1' })] })
  const comments = desiredBead(run.tasks[0]!, run).comments
  expect(comments.map((c) => c.marker)).toEqual([
    MARKER, '[hpipe t1/c1/r1]', '[hpipe t1/c1/r2]', '[hpipe t1/c1/r3]',
  ])
  expect(comments.map((c) => c.text.split('\n')[0])).toEqual([
    'Before merge, the human checks: the reader shows no ghost after a page turn (from d1)',
    'Failed on 9e06c261: a ghost on page 3', 'Confirmed by the human on 9e06c261', 'Waived by the human: ok',
  ])
  expect(comments.every((c) => c.text.endsWith(c.marker))).toBe(true)
})

test('a check comment goes only to an open bead, and a ruling that releases the hold is posted before the close', () => {
  const run = held({ merged_at_ms: 5, before_merge: [checkOf('c1', [ruling('confirmed', CHECKED_HEAD)])] })
  const task = run.tasks[0]!
  const desired = desiredBead(task, run)
  const open = callsFor(desired, bead({ status: 'blocked', labels: ['merge', AWAITING_HUMAN_LABEL], assignee: 'hpipe' }),
    closeReason(task), 'per-task')
  expect(open.map((c) => c.kind)).toEqual(['update', 'comment', 'comment', 'close'])

  const closed = callsFor(desired, bead({ status: 'closed', metadata: { 'hpipe.run': 'r1' }, assignee: 'hpipe' }),
    closeReason(task), 'per-task')
  expect(closed).toEqual([])
})

test('a single-PR task\'s check is posted while its bead is open, and its rulings after the landing are not', () => {
  const landed = [{ title: 'fix: x', land_sha: 'abc', at: 1 }]
  const run = singlePrRun([heldTask({ phase: 'done', merged_at_ms: 5, landed, before_merge: [
    checkOf('c1', [ruling('confirmed', CHECKED_HEAD)]),
  ] })])
  const task = run.tasks[0]!
  const desired = desiredBead(task, run)
  expect(desired.status).toBe('closed')
  expect(callsFor(desired, bead({ status: 'closed', metadata: { [RUN_METADATA_KEY]: run.run_id } }),
    closeReason(task, run), 'single-pr')).toEqual([])
})

test('a held, merged task is not waiting on its close, so a store failure marks nothing out of sync', async () => {
  const run = held({ merged_at_ms: 5 })
  await syncBeads([run], {
    bdFor: () => { throw new Error('no store is opened') },
    hasStore: async () => false,
    now: () => 1_000, budgetMs: 2_000, claimants: async () => [],
    passNotices: new Map(), lockContention: new Map(), slugCursor: { index: 0 },
    persist: async () => {}, log: () => {},
  })
  expect(run.tasks[0]!.bead_sync.failures).toBe(0)
})
