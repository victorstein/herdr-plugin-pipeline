import { expect, test } from 'bun:test'
import {
  isTier, modeOf, nextPhase, nextRunPhase, RUN_ROWS, runRow, TASK_ROWS, taskRow, TIERS, tierOf, type Tier,
} from '../src/lib/phases'
import type { TaskPhase } from '../src/lib/types'

test('every run phase has exactly one row', () => {
  const seen = new Set(RUN_ROWS.map((r) => r.phase))
  expect(seen.size).toBe(RUN_ROWS.length)
  expect(RUN_ROWS.length).toBe(9)
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
  expect(TASK_ROWS.length).toBe(23)
})

test('the worker-owned rows are the design loop, plus a single-PR run\'s sync', () => {
  const worker = TASK_ROWS.filter((r) => r.actor === 'worker').map((r) => r.phase).sort()
  expect(worker).toEqual([
    'implement', 'plan', 'plan-review', 'pr-review', 'pr-review-intent',
    'pr-review-quality', 'research', 'spec', 'spec-review', 'sync',
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
    'land-queue', 'merge', 'plan', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality',
    'research', 'spec', 'spec-review', 'sync', 'teardown',
  ])
  expect(RUN_ROWS.filter((r) => r.stallable).map((r) => r.phase).sort())
    .toEqual(['branch-review', 'dispatch', 'execute', 'ship', 'ship-ci', 'ship-merge'])
})

test('exactly the probe-only rows are outside the escalating signals', () => {
  const escalating = new Set(['artifact', 'verdict', 'pr', 'synced'])
  const probeOnly = [...RUN_ROWS, ...TASK_ROWS]
    .filter((r) => r.stallable && !escalating.has(r.signal)).map((r) => r.phase)
  expect(probeOnly).toEqual(['dispatch', 'execute', 'ship-ci', 'ship-merge', 'blocked-on-files', 'ci',
    'land-queue', 'merge', 'close', 'teardown', 'blocked-on-decision', 'escalated'])
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

test('every tier opens one pr-review after implement, and it clears to ci', () => {
  const phases = TASK_ROWS.map((r) => r.phase)
  expect(phases.indexOf('pr-review')).toBe(phases.indexOf('implement') + 1)
  expect(taskRow('implement').onClear).toBe('pr-review')
  expect(taskRow('pr-review')).toMatchObject({
    actor: 'worker', signal: 'verdict', onClear: 'ci', onBlocker: 'implement',
    counter: 'pr-review', prompt: 'pr-review', stallable: true, holdsFiles: true,
  })
  expect(taskRow('pr-review').tiers).toBeUndefined()
})

test('only the skippable reviews carry tiers, and no tier runs the heavy pair any more', () => {
  const tiered = Object.fromEntries(
    TASK_ROWS.filter((r) => r.tiers !== undefined).map((r) => [r.phase, r.tiers]),
  )
  expect(tiered).toEqual({
    'plan-review': ['standard', 'heavy'],
    'pr-review-intent': [],
    'pr-review-quality': [],
  })
})

test('a task already in either retired heavy stage leaves for what follows the PR review on its route', () => {
  for (const tier of TIERS) {
    for (const phase of ['pr-review-intent', 'pr-review-quality'] as const) {
      expect(nextPhase({ tier, mode: 'per-task' }, taskRow(phase)), `${tier} per-task ${phase}`).toBe('ci')
      expect(nextPhase({ tier, mode: 'single-pr' }, taskRow(phase)), `${tier} single-pr ${phase}`).toBe('land-queue')
    }
  }
})

test('the retired heavy stages keep their prompts and send-backs, for a task already in one', () => {
  for (const phase of ['pr-review-intent', 'pr-review-quality'] as const) {
    expect(taskRow(phase)).toMatchObject({
      actor: 'worker', signal: 'verdict', onBlocker: 'implement', counter: phase, prompt: phase, holdsFiles: true,
    })
  }
})

const TIERED_EXITS: Partial<Record<TaskPhase, Record<Tier, TaskPhase>>> = {
  'plan': { light: 'blocked-on-files', standard: 'plan-review', heavy: 'plan-review' },
  'pr-review-intent': { light: 'ci', standard: 'ci', heavy: 'ci' },
  // A per-task route skips the single-PR rows, so it leaves `ci` for `merge` as it always did.
  'ci': { light: 'merge', standard: 'merge', heavy: 'merge' },
  'land-queue': { light: 'merge', standard: 'merge', heavy: 'merge' },
}

test('nextPhase follows onClear past every row the tier skips, for every tier and row', () => {
  for (const row of TASK_ROWS) {
    for (const tier of TIERS) {
      if (row.onClear === undefined) {
        expect(() => nextPhase({ tier, mode: 'per-task' }, row), `${tier} from ${row.phase}`).toThrow()
        continue
      }
      const expected = TIERED_EXITS[row.phase]?.[tier] ?? row.onClear
      expect(nextPhase({ tier, mode: 'per-task' }, row), `${tier} from ${row.phase}`).toBe(expected)
    }
  }
})

function routeFromQueued(tier: Tier): TaskPhase[] {
  const route: TaskPhase[] = ['queued']
  while (route.at(-1) !== 'ci') {
    if (route.length > TASK_ROWS.length) throw new Error(`${tier} never reaches ci`)
    route.push(nextPhase({ tier, mode: 'per-task' }, taskRow(route.at(-1)!)))
  }
  return route
}

test('each tier walks exactly the rows the tier table names', () => {
  const head: TaskPhase[] = ['queued', 'research', 'spec', 'spec-review', 'plan']
  expect(routeFromQueued('light'))
    .toEqual([...head, 'blocked-on-files', 'implement', 'pr-review', 'ci'])
  expect(routeFromQueued('standard'))
    .toEqual([...head, 'plan-review', 'blocked-on-files', 'implement', 'pr-review', 'ci'])
  expect(routeFromQueued('heavy'))
    .toEqual([...head, 'plan-review', 'blocked-on-files', 'implement', 'pr-review', 'ci'])
})

function singlePrRoute(tier: Tier): TaskPhase[] {
  const route: TaskPhase[] = ['queued']
  while (route.at(-1) !== 'merge') {
    if (route.length > TASK_ROWS.length) throw new Error(`${tier} never reaches merge`)
    route.push(nextPhase({ tier, mode: 'single-pr' }, taskRow(route.at(-1)!)))
  }
  return route
}

test('a single-PR route skips ci and lands through land-queue and sync, in every tier', () => {
  const head: TaskPhase[] = ['queued', 'research', 'spec', 'spec-review', 'plan']
  expect(singlePrRoute('light'))
    .toEqual([...head, 'blocked-on-files', 'implement', 'pr-review', 'land-queue', 'sync', 'merge'])
  expect(singlePrRoute('heavy')).toEqual([
    ...head, 'plan-review', 'blocked-on-files', 'implement', 'pr-review', 'land-queue', 'sync', 'merge',
  ])
})

test('the run mode is read off the batch, and a run with none is per-task', () => {
  expect(modeOf({})).toBe('per-task')
  expect(modeOf({ batch: undefined })).toBe('per-task')
  expect(modeOf({ batch: { branch: 'batch/x' } })).toBe('single-pr')
})

test('branch-review leads to done per-task and to ship single-PR', () => {
  expect(nextRunPhase('per-task', runRow('branch-review'))).toBe('done')
  expect(nextRunPhase('single-pr', runRow('branch-review'))).toBe('ship')
  expect(nextRunPhase('single-pr', runRow('ship'))).toBe('ship-ci')
  expect(nextRunPhase('single-pr', runRow('ship-ci'))).toBe('ship-merge')
  expect(nextRunPhase('single-pr', runRow('ship-merge'))).toBe('done')
})

test('the single-PR rows are the landing rows and the ship rows, and only sync takes any worker', () => {
  const singlePr = [...RUN_ROWS, ...TASK_ROWS]
    .filter((r) => r.modes?.length === 1 && r.modes[0] === 'single-pr').map((r) => r.phase)
  expect(singlePr).toEqual(['ship', 'ship-ci', 'ship-merge', 'land-queue', 'sync'])
  expect(TASK_ROWS.filter((r) => r.modes?.includes('per-task') && r.modes.length === 1).map((r) => r.phase))
    .toEqual(['ci'])
  expect(TASK_ROWS.filter((r) => r.anyWorker).map((r) => r.phase)).toEqual(['sync'])
})
