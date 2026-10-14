import { expect, test } from 'bun:test'
import {
  checkClause, type CheckState, checksIn, checkState, gateHead, heldForTheHuman, humanIsAsked, mergedWithCheckOwed, nextCheckId,
  owedAt, waitsOnlyOnTheHuman,
} from '../src/lib/before-merge'
import type { TaskPhase } from '../src/lib/types'
import { CHECKED_HEAD, checkOf, heldTask, NEWER_HEAD, perTaskRun, ruling, singlePrRun } from './helpers/before-merge'

const stateOf = (run: Parameters<typeof checkState>[0], index = 0) => checkState(run, checksIn(run)[index]!)

test('ids run in one sequence across the run\'s task and run checks', () => {
  const run = singlePrRun([
    heldTask({ before_merge: [checkOf('c1'), checkOf('c3')] }),
    heldTask({ task_id: 't2', before_merge: [checkOf('c4')] }),
  ])
  run.before_merge = [checkOf('c2')]
  expect(checksIn(run).map((h) => `${h.check.id}:${h.task?.task_id ?? 'run'}`)).toEqual(['c1:t1', 'c2:run', 'c3:t1', 'c4:t2'])
  expect(nextCheckId(run)).toBe('c5')
  expect(nextCheckId(perTaskRun([heldTask()]))).toBe('c1')
})

test('the gate head is the head CI passed on: the task\'s per-task, the batch\'s single-PR', () => {
  const task = heldTask({ ci_head: { sha: 'task-head', seen_at: 1 } })
  expect(gateHead(perTaskRun([task]), task)).toBe('task-head')
  const run = singlePrRun([task])
  expect(gateHead(run, task)).toBe(CHECKED_HEAD)
  expect(gateHead(run, null)).toBe(CHECKED_HEAD)
  expect(gateHead(perTaskRun([heldTask({ ci_head: undefined })]), heldTask({ ci_head: undefined }))).toBeNull()
})

test('each row of the state table, against the gate head', () => {
  const cases: Array<[string, ReturnType<typeof ruling>[], CheckState['kind']]> = [
    ['no ruling', [], 'waiting-on-the-human'],
    ['confirmed on the gate head', [ruling('confirmed', CHECKED_HEAD)], 'confirmed'],
    ['confirmed on an older head', [ruling('confirmed', NEWER_HEAD)], 'waiting-on-the-human'],
    ['failed on the gate head', [ruling('failed', CHECKED_HEAD, 'ghost')], 'waiting-on-a-fix'],
    ['failed on another head', [ruling('failed', NEWER_HEAD, 'ghost')], 'waiting-on-the-human'],
    ['waived', [ruling('waived', null, 'release window')], 'waived'],
    ['a later ruling replaces an earlier one', [ruling('failed', CHECKED_HEAD, 'x'), ruling('waived', null, 'y')], 'waived'],
  ]
  for (const [name, resolutions, kind] of cases) {
    const run = perTaskRun([heldTask({ before_merge: [checkOf('c1', resolutions)] })])
    expect(stateOf(run).kind, name).toBe(kind)
    const batch = singlePrRun([heldTask({ before_merge: [checkOf('c1', resolutions)], landed: [] })], 'ship-ci')
    expect(stateOf(batch).kind, `${name}, single-PR`).toBe(kind)
  }
})

test('a stale confirmation names the head it covered and the head there is now', () => {
  const run = perTaskRun([heldTask({ before_merge: [checkOf('c1', [ruling('confirmed', NEWER_HEAD)])] })])
  expect(stateOf(run)).toMatchObject({ kind: 'waiting-on-the-human', last: { head: NEWER_HEAD }, headNow: CHECKED_HEAD })
})

test('with no gate head, after a manual rewind past CI, a confirmation is taken as given', () => {
  const run = perTaskRun([heldTask({ ci_head: undefined, before_merge: [checkOf('c1', [ruling('confirmed', NEWER_HEAD)])] })])
  expect(stateOf(run).kind).toBe('confirmed')
})

test('per-task, a check is not needed once its task finished with no merge, and binds once it merged', () => {
  for (const phase of ['failed', 'orphaned', 'done', 'blocked-on-failure'] as TaskPhase[]) {
    const unmerged = perTaskRun([heldTask({ phase, before_merge: [checkOf('c1')] })])
    expect(stateOf(unmerged), phase).toEqual({ kind: 'not-needed', why: 't1 never merged' })
  }
  const mergedThenFailed = perTaskRun([heldTask({ phase: 'failed', merged_at_ms: 5, before_merge: [checkOf('c1')] })])
  expect(stateOf(mergedThenFailed).kind).toBe('waiting-on-the-human')
  const inFlight = perTaskRun([heldTask({ phase: 'pr-review', before_merge: [checkOf('c1')] })])
  expect(stateOf(inFlight).kind).toBe('waiting-on-the-human')
})

test('single-PR, a task check is not needed once the run ships without that task\'s landing', () => {
  const landing = [{ title: 'fix: x', land_sha: 'abc', at: 1 }]
  const neverLanded = (phase: Parameters<typeof singlePrRun>[1]) =>
    singlePrRun([heldTask({ phase: 'failed', landed: [], before_merge: [checkOf('c1')] })], phase)
  expect(stateOf(neverLanded('ship-merge'))).toEqual({ kind: 'not-needed', why: 't1 never landed' })
  expect(stateOf(neverLanded('done')).kind).toBe('not-needed')
  expect(stateOf(neverLanded('ship-ci')).kind).toBe('waiting-on-the-human')
  const landedThenAbandoned = singlePrRun([heldTask({ phase: 'failed', landed: landing, before_merge: [checkOf('c1')] })])
  expect(stateOf(landedThenAbandoned).kind).toBe('waiting-on-the-human')
  const runCheck = singlePrRun([])
  runCheck.before_merge = [checkOf('c1')]
  expect(stateOf(runCheck).kind).toBe('waiting-on-the-human')
})

test('owedAt: a per-task task\'s own checks; single-PR, every check at ship-merge and none at a landing', () => {
  const t1 = heldTask({ before_merge: [checkOf('c1'), checkOf('c2', [ruling('confirmed', CHECKED_HEAD)])] })
  const perTask = perTaskRun([t1])
  expect(owedAt(perTask, t1).map((o) => o.check.id)).toEqual(['c1'])
  expect(owedAt(perTask, null)).toEqual([])

  const landed = [{ title: 'fix: x', land_sha: 'abc', at: 1 }]
  const t2 = heldTask({ task_id: 't2', phase: 'done', landed, before_merge: [checkOf('c1')] })
  const batch = singlePrRun([t2])
  batch.before_merge = [checkOf('c2', [ruling('waived', null, 'release window')]), checkOf('c3')]
  expect(owedAt(batch, null).map((o) => o.check.id)).toEqual(['c1', 'c3'])
  expect(owedAt(batch, t2)).toEqual([])
})

test('waitsOnlyOnTheHuman is false once any owed check waits on a fix', () => {
  const run = singlePrRun([])
  run.before_merge = [checkOf('c1')]
  expect(waitsOnlyOnTheHuman(run, null)).toBe(true)
  run.before_merge.push(checkOf('c2', [ruling('failed', CHECKED_HEAD, 'ghost')]))
  expect(waitsOnlyOnTheHuman(run, null)).toBe(false)
  run.before_merge = [checkOf('c1', [ruling('confirmed', CHECKED_HEAD)])]
  expect(waitsOnlyOnTheHuman(run, null)).toBe(false)
})

test('heldForTheHuman: a per-task task in merge that owes a check, merged or not, while the run is driven', () => {
  const owing = heldTask({ before_merge: [checkOf('c1')] })
  expect(heldForTheHuman(perTaskRun([owing]), owing)).toBe(true)
  const merged = heldTask({ merged_at_ms: 5, before_merge: [checkOf('c1')] })
  expect(heldForTheHuman(perTaskRun([merged]), merged)).toBe(true)

  const settled = heldTask({ before_merge: [checkOf('c1', [ruling('confirmed', CHECKED_HEAD)])] })
  expect(heldForTheHuman(perTaskRun([settled]), settled)).toBe(false)
  const notAtTheGate = heldTask({ phase: 'ci', before_merge: [checkOf('c1')] })
  expect(heldForTheHuman(perTaskRun([notAtTheGate]), notAtTheGate)).toBe(false)
  for (const phase of ['done', 'escalated'] as const) {
    const parked = perTaskRun([merged])
    parked.phase = phase
    expect(heldForTheHuman(parked, merged), phase).toBe(false)
  }
  const batchTask = heldTask({ before_merge: [checkOf('c1')] })
  expect(heldForTheHuman(singlePrRun([batchTask]), batchTask)).toBe(false)
})

test('mergedWithCheckOwed names per-task tasks whose merge is recorded with a check still owed', () => {
  const run = perTaskRun([
    heldTask({ task_id: 't1', phase: 'done', merged_at_ms: 5, before_merge: [checkOf('c1')] }),
    heldTask({ task_id: 't2', phase: 'done', merged_at_ms: 5, before_merge: [checkOf('c2', [ruling('waived', null, 'ok')])] }),
    heldTask({ task_id: 't3', phase: 'merge', before_merge: [checkOf('c3')] }),
  ])
  expect(mergedWithCheckOwed(run).map((t) => t.task_id)).toEqual(['t1'])
  expect(mergedWithCheckOwed(singlePrRun([heldTask({ merged_at_ms: 5, before_merge: [checkOf('c1')] })]))).toEqual([])
})

test('humanIsAsked: per-task at its task\'s merge or once it merged; single-PR only at ship-merge', () => {
  const at = (phase: TaskPhase, over: Parameters<typeof heldTask>[0] = {}) => {
    const task = heldTask({ phase, ...over })
    return humanIsAsked(perTaskRun([task]), task)
  }
  expect(at('merge')).toBe(true)
  expect(at('close', { merged_at_ms: 5 })).toBe(true)
  expect(at('research')).toBe(false)
  expect(at('ci')).toBe(false)
  const task = heldTask({ phase: 'done' })
  expect(humanIsAsked(singlePrRun([task], 'ship-merge'), task)).toBe(true)
  expect(humanIsAsked(singlePrRun([task], 'ship-merge'), null)).toBe(true)
  expect(humanIsAsked(singlePrRun([task], 'ship-ci'), null)).toBe(false)
})

// The v2.2.0 smoke run: a check recorded at intake read "waiting on the human" while its task was in research.
test('before its gate, a check says what it holds and when the human is asked', () => {
  const clauseOf = (run: Parameters<typeof checkState>[0]) => checkClause(run, checksIn(run)[0]!)
  const early = (over: Parameters<typeof heldTask>[0]) =>
    perTaskRun([heldTask({ phase: 'research', pr: null, ci_head: undefined, before_merge: [checkOf('c1')], ...over })])

  expect(clauseOf(early({}))).toBe("owed before t1's PR merges; the human is asked at merge")
  expect(clauseOf(early({ phase: 'ci', pr: 255 }))).toBe('owed before PR #255 merges; the human is asked at merge')
  expect(clauseOf(early({
    phase: 'ci', pr: 255, ci_head: { sha: CHECKED_HEAD, seen_at: 1 }, before_merge: [checkOf('c1', [ruling('confirmed', NEWER_HEAD)])],
  }))).toBe('confirmed on 5e6f7a8b, but the head is now 9e06c261: the human is asked again at merge')
  expect(clauseOf(early({
    phase: 'ci', pr: 255, ci_head: { sha: CHECKED_HEAD, seen_at: 1 }, before_merge: [checkOf('c1', [ruling('failed', NEWER_HEAD, 'a ghost')])],
  }))).toBe('failed on 5e6f7a8b: a ghost; the human checks the next head at merge')
  expect(clauseOf(early({ phase: 'merge', pr: 255 }))).toBe('waiting on the human')

  const batch = singlePrRun([], 'execute')
  batch.batch!.pr = null
  batch.before_merge = [checkOf('c1')]
  expect(clauseOf(batch)).toBe('owed before the batch PR merges; the human is asked at ship-merge')
  batch.phase = 'ship-merge'
  expect(clauseOf(batch)).toBe('waiting on the human')
})
