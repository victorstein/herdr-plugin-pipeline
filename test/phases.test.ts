import { expect, test } from 'bun:test'
import {
  isTier, nextPhase, RUN_ROWS, runRow, TASK_ROWS, taskRow, TIERS, tierOf, type Tier,
} from '../src/lib/phases'
import type { TaskPhase } from '../src/lib/types'

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
  expect(TASK_ROWS.length).toBe(21)
})

test('the nine worker-owned rows are exactly the design loop', () => {
  const worker = TASK_ROWS.filter((r) => r.actor === 'worker').map((r) => r.phase).sort()
  expect(worker).toEqual([
    'implement', 'plan', 'plan-review', 'pr-review', 'pr-review-intent',
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

test('the stallable set covers the last mile — #19', () => {
  expect(TASK_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort()).toEqual([
    'blocked-on-decision', 'blocked-on-files', 'ci', 'close', 'escalated', 'implement',
    'merge', 'plan', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality',
    'research', 'spec', 'spec-review', 'teardown',
  ])
  expect(RUN_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort())
    .toEqual(['branch-review', 'dispatch', 'execute'])
})

test('exactly the nine probe-only rows are outside the escalating signals', () => {
  const escalating = new Set(['artifact', 'verdict', 'pr'])
  const probeOnly = [...RUN_ROWS, ...TASK_ROWS]
    .filter((r) => r.stallable && !escalating.has(r.signal)).map((r) => r.phase)
  expect(probeOnly).toEqual(['dispatch', 'execute', 'blocked-on-files', 'ci', 'merge',
    'close', 'teardown', 'blocked-on-decision', 'escalated'])
})

test('the actorless and human-owned stallable rows name a probe target', () => {
  // table.test.ts counts only `orchestrator` and `worker` as resolving to a pane,
  // so these must declare one; merge resolves already.
  for (const phase of ['ci', 'close', 'teardown', 'escalated'] as const) {
    expect(taskRow(phase).probeTarget, `${phase} needs a probe target`).toBe('orchestrator')
  }
  expect(taskRow('merge').probeTarget).toBeUndefined()
})

test('the tiers are ordered lightest first', () => {
  expect(TIERS).toEqual(['light', 'standard', 'heavy'])
})

test('isTier accepts exactly the three tiers', () => {
  for (const tier of TIERS) expect(isTier(tier)).toBe(true)
  for (const other of ['', 'huge', 'Light', 'pipeline:tier-light']) expect(isTier(other)).toBe(false)
})

test('a task with no recorded tier reads as heavy, which is every review it ran before tiers', () => {
  expect(tierOf({})).toBe('heavy')
  expect(tierOf({ tier: 'light' })).toBe('light')
})

test('pr-review sits between implement and the heavy tier\'s two PR reviews', () => {
  const phases = TASK_ROWS.map((r) => r.phase)
  expect(phases.indexOf('pr-review')).toBe(phases.indexOf('implement') + 1)
  expect(taskRow('implement').onClear).toBe('pr-review')
  expect(taskRow('pr-review')).toMatchObject({
    actor: 'worker', signal: 'verdict', onClear: 'pr-review-intent', onBlocker: 'implement',
    counter: 'pr-review', prompt: 'pr-review', stallable: true, holdsFiles: true,
    tiers: ['light', 'standard'],
  })
})

test('only the skippable reviews carry tiers', () => {
  const tiered = Object.fromEntries(
    TASK_ROWS.filter((r) => r.tiers !== undefined).map((r) => [r.phase, r.tiers]),
  )
  expect(tiered).toEqual({
    'plan-review': ['standard', 'heavy'],
    'pr-review': ['light', 'standard'],
    'pr-review-intent': ['heavy'],
    'pr-review-quality': ['heavy'],
  })
})

const TIERED_EXITS: Partial<Record<TaskPhase, Record<Tier, TaskPhase>>> = {
  'plan': { light: 'blocked-on-files', standard: 'plan-review', heavy: 'plan-review' },
  'implement': { light: 'pr-review', standard: 'pr-review', heavy: 'pr-review-intent' },
  'pr-review': { light: 'ci', standard: 'ci', heavy: 'pr-review-intent' },
  'pr-review-intent': { light: 'ci', standard: 'ci', heavy: 'pr-review-quality' },
}

test('nextPhase follows onClear past every row the tier skips, for every tier and row', () => {
  for (const row of TASK_ROWS) {
    for (const tier of TIERS) {
      if (row.onClear === undefined) {
        expect(() => nextPhase(tier, row), `${tier} from ${row.phase}`).toThrow()
        continue
      }
      const expected = TIERED_EXITS[row.phase]?.[tier] ?? row.onClear
      expect(nextPhase(tier, row), `${tier} from ${row.phase}`).toBe(expected)
    }
  }
})

function routeFromQueued(tier: Tier): TaskPhase[] {
  const route: TaskPhase[] = ['queued']
  while (route.at(-1) !== 'ci') {
    if (route.length > TASK_ROWS.length) throw new Error(`${tier} never reaches ci`)
    route.push(nextPhase(tier, taskRow(route.at(-1)!)))
  }
  return route
}

test('each tier walks exactly the rows the tier table names', () => {
  const head: TaskPhase[] = ['queued', 'research', 'spec', 'spec-review', 'plan']
  expect(routeFromQueued('light'))
    .toEqual([...head, 'blocked-on-files', 'implement', 'pr-review', 'ci'])
  expect(routeFromQueued('standard'))
    .toEqual([...head, 'plan-review', 'blocked-on-files', 'implement', 'pr-review', 'ci'])
  expect(routeFromQueued('heavy')).toEqual([
    ...head, 'plan-review', 'blocked-on-files', 'implement', 'pr-review-intent', 'pr-review-quality', 'ci',
  ])
})
