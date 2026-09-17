import { expect, test } from 'bun:test'
import { RUN_ROWS, runRow, TASK_ROWS, taskRow } from '../src/lib/phases'

test('every run phase has exactly one row', () => {
  const seen = new Set(RUN_ROWS.map((r) => r.phase))
  expect(seen.size).toBe(RUN_ROWS.length)
  expect(RUN_ROWS.length).toBe(6)
})

test('runRow returns the row for a phase', () => {
  expect(runRow('branch-review').actor).toBe('orchestrator')
  expect(runRow('branch-review').counter).toBe('branch-review')
})

test('intake is an orchestrator row with no counter', () => {
  expect(runRow('intake').actor).toBe('orchestrator')
  expect(runRow('intake').counter).toBeUndefined()
})

test('every task phase has exactly one row', () => {
  const seen = new Set(TASK_ROWS.map((r) => r.phase))
  expect(seen.size).toBe(TASK_ROWS.length)
  expect(TASK_ROWS.length).toBe(20)
})

test('the eight worker-owned rows are exactly the design loop', () => {
  const worker = TASK_ROWS.filter((r) => r.actor === 'worker').map((r) => r.phase).sort()
  expect(worker).toEqual([
    'implement', 'plan', 'plan-review', 'pr-review-intent',
    'pr-review-quality', 'research', 'spec', 'spec-review',
  ])
})

test('implement is probed — it is the longest worker phase and the one that hangs', () => {
  expect(taskRow('implement').stallable).toBe(true)
})

test('ci carries its own counter — it is not a review row but it loops', () => {
  expect(taskRow('ci').counter).toBe('ci')
  expect(taskRow('ci').onBlocker).toBe('implement')
})

test('blocked-on-files holds no files and has no actor pane', () => {
  expect(taskRow('blocked-on-files').holdsFiles).toBe(false)
  expect(taskRow('blocked-on-files').actor).toBeUndefined()
  expect(taskRow('blocked-on-files').probeTarget).toBe('orchestrator')
})

test('the stallable set is exactly what #15 assumed — widening it belongs to #19', () => {
  expect(TASK_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort()).toEqual([
    'blocked-on-decision', 'blocked-on-files', 'implement', 'plan', 'plan-review',
    'pr-review-intent', 'pr-review-quality', 'research', 'spec', 'spec-review',
  ])
  expect(RUN_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort())
    .toEqual(['branch-review', 'dispatch', 'execute'])
})

test('exactly the four probe-only rows are outside the escalating signals', () => {
  const escalating = new Set(['artifact', 'verdict', 'pr'])
  const probeOnly = [...RUN_ROWS, ...TASK_ROWS]
    .filter((r) => r.stallable && !escalating.has(r.signal)).map((r) => r.phase)
  expect(probeOnly).toEqual(['dispatch', 'execute', 'blocked-on-files', 'blocked-on-decision'])
})
