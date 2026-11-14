import { expect, test } from 'bun:test'
import { buildBoard, humanOwes, runOwes, type BoardInput } from '../src/board/model'
import { sceneFor } from '../src/board/scenes'
import { MOCHA } from '../src/kit/palette'
import type { PaneHold } from '../src/lib/delivery-health'
import type { Decision, Run, Task, TaskPhase } from '../src/lib/types'
import { CHECKED_HEAD, checkOf, heldTask, perTaskRun, ruling, singlePrRun } from './helpers/before-merge'

const task = (over: Partial<Task> = {}): Task => heldTask({ ci: null, pr: null, ...over })

function input(run: Run, over: Partial<BoardInput> = {}): BoardInput {
  const panes = run.tasks.flatMap((t) => (t.pane_id === null ? [] : [t.pane_id]))
  if (run.orchestrator_pane !== null) panes.push(run.orchestrator_pane)
  return {
    run, holds: {}, livePanes: new Set(panes), ctx: new Map(), orchestratorsMove: () => false, cleared: new Set(), ...over,
  }
}

const hold = (code: string, over: Partial<PaneHold> = {}): PaneHold => ({ since: 1, failures: 1, code, ...over })

function only(board: ReturnType<typeof buildBoard>) {
  const cards = Object.values(board).flat()
  expect(cards).toHaveLength(1)
  return cards[0]!
}

const escalatedDecision = (id: string): Decision => ({
  id, asked_at: 1, from_phase: 'implement', question: 'q', recommendation: 'r', answer: null, answered_by: null,
  answered_at: null, prompted_at: 1, escalated_at: 2, orchestrator_recommendation: 'o',
})

test('a routine per-task merge is Working, and the orchestrator\'s move outranks its CI and PR', () => {
  const run = perTaskRun([heldTask({ ci: 'pass', pr: 255 })])
  const waiting = only(buildBoard(input(run)))
  expect(waiting.column).toBe('working')
  expect(waiting.badge.text).toBe('ci ✓')
  const moving = only(buildBoard(input(run, { orchestratorsMove: () => true })))
  expect(moving.column).toBe('working')
  expect(moving.badge.text).toBe("orchestrator's move")
})

test('a single-PR landing never asks whose move it is', () => {
  let asked = false
  const run = singlePrRun([task({ phase: 'merge' })], 'execute')
  const card = only(buildBoard(input(run, { orchestratorsMove: () => (asked = true) })))
  expect(asked).toBe(false)
  expect(card.column).toBe('working')
})

test('a merge held for a before-merge check is in Needs you, badged with the check', () => {
  const run = perTaskRun([heldTask({ before_merge: [checkOf('c1', [], { check: 'the dial turns smoothly' })] })])
  const card = only(buildBoard(input(run)))
  expect(card.column).toBe('needs')
  expect(card.badge.text).toBe('the dial turns smoothly')
})

test('a merge whose check failed waits on a fix, not on the human', () => {
  const failed = checkOf('c1', [ruling('failed', CHECKED_HEAD, 'ghost')], { check: 'the dial turns smoothly' })
  const run = perTaskRun([heldTask({ before_merge: [failed] })])
  expect(only(buildBoard(input(run))).column).toBe('working')
})

test('a task merged past its gate with a check still owed is in Needs you', () => {
  const owed = checkOf('c1', [], { check: 'the dial turns smoothly' })
  const run = perTaskRun([heldTask({ phase: 'done', merged_at_ms: 5, before_merge: [owed] })])
  const card = only(buildBoard(input(run)))
  expect(card.column).toBe('needs')
  expect(card.badge.text).toBe('the dial turns smoothly')
})

test('a finished run\'s unfinished tasks are Idle: aborted, or named by their phase', () => {
  const run = perTaskRun([
    task({ phase: 'ci', phase_entered_at: 3 }),
    task({ task_id: 't2', phase: 'escalated', pane_id: 'w8:p1', phase_entered_at: 2 }),
    task({ task_id: 't3', phase: 'failed', pane_id: 'w9:p1', phase_entered_at: 1 }),
  ])
  run.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  run.escalated_from = 'execute'
  run.phase = 'done'
  const board = buildBoard(input(run))
  expect(board.needs).toEqual([])
  expect(board.idle.map((c) => [c.id, c.badge.text, c.badge.color])).toEqual([
    ['t1', 'aborted', MOCHA.overlay0], ['t2', 'aborted', MOCHA.overlay0], ['t3', 'failed', MOCHA.red],
  ])

  run.escalated_from = null
  expect(buildBoard(input(run)).idle.map((c) => c.badge.text)).toEqual(['ci', 'escalated', 'failed'])
})

test('an escalated task is in Needs you', () => {
  const card = only(buildBoard(input(perTaskRun([task({ phase: 'escalated' })]))))
  expect(card.column).toBe('needs')
  expect(card.badge.text).toBe('escalated')
})

test('an unanswered escalated decision is in Needs you, naming the decision', () => {
  const run = perTaskRun([task({ phase: 'blocked-on-decision', decision_from: 'implement', decisions: [escalatedDecision('d2')] })])
  const card = only(buildBoard(input(run)))
  expect(card.column).toBe('needs')
  expect(card.badge.text).toBe('answer decision d2')
})

test('failed, orphaned and blocked-on-failure are in Needs you, badged with the phase', () => {
  for (const phase of ['failed', 'orphaned', 'blocked-on-failure'] as TaskPhase[]) {
    const card = only(buildBoard(input(perTaskRun([task({ phase })]))))
    expect(card.column, phase).toBe('needs')
    expect(card.badge.text).toBe(phase)
  }
})

test('a stuck_input hold on the worker\'s pane is in Needs you', () => {
  const run = perTaskRun([task({ phase: 'implement' })])
  const card = only(buildBoard(input(run, { holds: { 'w7:p1': hold('stuck_input') } })))
  expect(card.column).toBe('needs')
  expect(card.badge.text).toBe('input box has text')
})

test('a usage limit with no readable reset needs you; a known reset is Idle', () => {
  const run = perTaskRun([task({ phase: 'implement' })])
  const unread = only(buildBoard(input(run, { holds: { 'w7:p1': hold('usage_limit', { until: null }) } })))
  expect(unread.column).toBe('needs')
  expect(unread.badge.text).toBe('usage limit')

  const known = only(buildBoard(input(run, { holds: { 'w7:p1': hold('usage_limit', { until: 5, reset: '10:20am' }) } })))
  expect(known.column).toBe('idle')
  expect(known.badge.text).toBe('10:20am')

  const noText = only(buildBoard(input(run, { holds: { 'w7:p1': hold('usage_limit', { until: 5 }) } })))
  expect(noText.column).toBe('idle')
  expect(noText.badge.text).toBe('usage limit')
})

test('done is Done, until the user clears it', () => {
  const run = perTaskRun([task({ phase: 'done' })])
  expect(only(buildBoard(input(run))).column).toBe('done')
  expect(Object.values(buildBoard(input(run, { cleared: new Set(['t1']) }))).flat()).toEqual([])
})

test('queued is Idle, badged with an unmet dependency', () => {
  const free = only(buildBoard(input(perTaskRun([task({ phase: 'queued', tier: 'light' })]))))
  expect(free.column).toBe('idle')
  expect(free.badge.text).toBe('light')

  const run = perTaskRun([
    task({ phase: 'queued', depends_on: ['t2'], phase_entered_at: 2 }),
    task({ task_id: 't2', bead: 'hp-2', phase: 'implement', pane_id: 'w8:p1' }),
  ])
  const waiting = buildBoard(input(run)).idle
  expect(waiting.map((c) => [c.id, c.badge.text])).toEqual([['t1', 'deps: hp-2']])
})

test('blocked-on-files is Idle, badged with a task holding the files', () => {
  const run = perTaskRun([
    task({ phase: 'blocked-on-files', files: ['src/a.ts'], phase_entered_at: 2 }),
    task({ task_id: 't2', bead: 'hp-2', phase: 'implement', files: ['src/a.ts'], pane_id: 'w8:p1' }),
  ])
  const idle = buildBoard(input(run)).idle
  expect(idle.map((c) => [c.id, c.badge.text])).toEqual([['t1', 'files: hp-2']])
})

test('a worker phase with no pane, or a dead one, is Idle with no agent', () => {
  for (const over of [{ pane_id: null }, { pane_id: 'w9:p9' }]) {
    const run = perTaskRun([task({ phase: 'implement', ...over })])
    const card = only(buildBoard(input(run, { livePanes: new Set(['w1:p1']) })))
    expect(card.column).toBe('idle')
    expect(card.badge.text).toBe('no agent')
  }
})

test('a Working badge prefers CI, then the PR, then the tier', () => {
  const badge = (over: Partial<Task>) => only(buildBoard(input(perTaskRun([task({ phase: 'implement', ...over })])))).badge.text
  expect(badge({ ci: 'pending', pr: 7 })).toBe('ci ●')
  expect(badge({ ci: 'fail', pr: 7 })).toBe('ci ✗')
  expect(badge({ ci: 'pass', pr: 7 })).toBe('ci ✓')
  expect(badge({ pr: 7 })).toBe('PR #7')
  for (const tier of ['light', 'standard', 'heavy'] as const) expect(badge({ tier })).toBe(tier)
})

test('a card carries the task\'s fields, and its column\'s scene', () => {
  const run = perTaskRun([
    task({ phase: 'implement', phase_entered_at: 40 }),
    task({ task_id: 't2', bead: 'hp-2', phase: 'failed', pane_id: 'w8:p1', phase_entered_at: 30 }),
    task({ task_id: 't3', bead: 'hp-3', phase: 'done', pane_id: null, phase_entered_at: 20 }),
    task({ task_id: 't4', bead: 'hp-4', phase: 'queued', pane_id: null, phase_entered_at: 10 }),
  ])
  const board = buildBoard(input(run, { ctx: new Map([['w7:p1', 42]]) }))
  expect(board.working[0]).toEqual({
    id: 't1', column: 'working', title: 'hp-1 Relabel the tile', subtitle: 'implement', badge: board.working[0]!.badge,
    since: 40, ctx: 42, scene: sceneFor(run.tasks[0]!), accessory: 'hardhat', enteredAt: null,
  })
  expect(board.needs[0]).toMatchObject({ id: 't2', scene: 'blocked', ctx: null, enteredAt: 30, since: 30 })
  expect(board.done[0]).toMatchObject({ id: 't3', scene: 'done', ctx: null, enteredAt: 20 })
  expect(board.idle[0]).toMatchObject({ id: 't4', scene: 'idle', enteredAt: null })
})

test('run cards lead Needs you for what the run owes', () => {
  const escalated = perTaskRun([])
  escalated.phase = 'escalated'
  expect(runOwes(escalated, new Set(['w1:p1']))).toBe('run escalated')

  const single = singlePrRun([])
  single.before_merge = [checkOf('c1', [], { check: 'the batch boots on device' })]
  expect(runOwes(single, new Set(['w1:p1']))).toBe('the batch boots on device')

  const notYetAsked = singlePrRun([], 'execute')
  notYetAsked.before_merge = [checkOf('c1', [], { check: 'the batch boots on device' })]
  expect(runOwes(notYetAsked, new Set(['w1:p1']))).toBeNull()
  expect(buildBoard(input(notYetAsked)).needs).toEqual([])

  const orphan = perTaskRun([])
  orphan.orchestrator_pane = null
  expect(runOwes(orphan, new Set())).toBe('orchestrator is not running')
  expect(runOwes(perTaskRun([]), new Set(['w1:p9']))).toBe('orchestrator is not running')

  expect(runOwes(perTaskRun([]), new Set(['w1:p1']))).toBeNull()

  const run = perTaskRun([task({ phase: 'failed' })])
  run.orchestrator_pane = null
  run.phase_entered_at = 7
  const board = buildBoard(input(run))
  expect(board.needs.map((c) => [c.id, c.badge.text])).toEqual([[`run:${run.run_id}`, 'orchestrator is not running'], ['t1', 'failed']])
  expect(board.needs[0]).toMatchObject({
    column: 'needs', title: 'a', subtitle: 'run · execute', since: 7, scene: 'blocked', accessory: 'hardhat', ctx: null, enteredAt: null,
  })
})

test('each column is newest-first, with the run card always first in Needs you', () => {
  const run = perTaskRun([
    task({ phase: 'implement', phase_entered_at: 10 }),
    task({ task_id: 't2', phase: 'implement', pane_id: 'w8:p1', phase_entered_at: 30 }),
    task({ task_id: 't3', phase: 'implement', pane_id: 'w9:p1', phase_entered_at: 20 }),
    task({ task_id: 't4', phase: 'failed', phase_entered_at: 5 }),
    task({ task_id: 't5', phase: 'escalated', phase_entered_at: 50 }),
  ])
  run.phase = 'escalated'
  run.phase_entered_at = 1
  const board = buildBoard(input(run))
  expect(board.working.map((c) => c.id)).toEqual(['t2', 't3', 't1'])
  expect(board.needs.map((c) => c.id)).toEqual([`run:${run.run_id}`, 't5', 't4'])
})

test('humanOwes is null for a task nobody is waiting on', () => {
  const run = perTaskRun([task({ phase: 'implement' })])
  expect(humanOwes(run, run.tasks[0]!, {})).toBeNull()
})
