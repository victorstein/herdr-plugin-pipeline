import { expect, test } from 'bun:test'
import {
  detectCycle, filesClearFor, filesOverlap, gateStatus, releasableFromFiles,
} from '../src/lib/gating'
import type { Task } from '../src/lib/types'

const task = (over: Partial<Task>): Task => ({
  task_id: 't', branch: 'b', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'queued', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

test('files overlap on a prefix, not only an exact path', () => {
  expect(filesOverlap(['packages/core/src/db/'], ['packages/core/src/db/usage.ts'])).toBe(true)
  expect(filesOverlap(['apps/api/'], ['packages/core/'])).toBe(false)
})

test('a task with satisfied dependencies is ready', () => {
  const done = task({ task_id: 't1', phase: 'done' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [done, waiting])).toEqual({ state: 'ready' })
})

test('a task waits on an unfinished dependency', () => {
  const running = task({ task_id: 't1', phase: 'implement' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [running, waiting])).toEqual({ state: 'waiting', on: ['t1'] })
})

test('a failed dependency blocks permanently rather than waiting forever', () => {
  const failed = task({ task_id: 't1', phase: 'failed' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [failed, waiting])).toEqual({ state: 'blocked-on-failure', on: ['t1'] })
})

test('an orphaned dependency also blocks permanently', () => {
  const orphaned = task({ task_id: 't1', phase: 'orphaned' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [orphaned, waiting]).state).toBe('blocked-on-failure')
})

test('a finished task does not hold its files', () => {
  const done = task({ task_id: 't1', phase: 'done', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/x.ts'] })
  expect(filesClearFor(waiting, [done, waiting])).toBe(true)
})

test('an escalated task still holds its files', () => {
  // Nothing tears an escalated task down, so its worktree and unmerged work
  // persist — releasing the lock would let a second task edit the same files.
  const stuck = task({ task_id: 't1', phase: 'escalated', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/x.ts'] })
  expect(filesClearFor(waiting, [stuck, waiting])).toBe(false)
})

test('an orphaned task releases its files, because its code already merged', () => {
  const merged = task({ task_id: 't1', phase: 'orphaned', files: ['apps/api/'] })
  const waiting = task({ task_id: 't2', phase: 'blocked-on-files', files: ['apps/api/main.ts'] })
  expect(filesClearFor(waiting, [merged, waiting])).toBe(true)
})

test('queued ignores file overlap — only depends_on gates it', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'queued', files: ['packages/core/src/'] })
  expect(gateStatus(t2, [t1, t2])).toEqual({ state: 'ready' })
})

test('blocked-on-files is held by an in-flight overlapping sibling', () => {
  const t1 = task({ task_id: 't1', phase: 'implement', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/src/'] })
  expect(filesClearFor(t2, [t1, t2])).toBe(false)
})

test('a design-phase sibling does not hold files', () => {
  const t1 = task({ task_id: 't1', phase: 'plan', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/'] })
  expect(filesClearFor(t2, [t1, t2])).toBe(true)
})

test('a failed sibling holds its files forever', () => {
  const t1 = task({ task_id: 't1', phase: 'failed', files: ['packages/core/'] })
  const t2 = task({ task_id: 't2', phase: 'blocked-on-files', files: ['packages/core/'] })
  expect(filesClearFor(t2, [t1, t2])).toBe(false)
})

test('blocked-on-decision inherits file-holding from decision_from', () => {
  const held = task({ task_id: 't1', phase: 'blocked-on-decision', files: ['a/'] })
  held.decision_from = 'implement'
  const free = task({ task_id: 't3', phase: 'blocked-on-decision', files: ['a/'] })
  free.decision_from = 'plan'
  const waiter = task({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] })
  expect(filesClearFor(waiter, [held, waiter])).toBe(false)
  expect(filesClearFor(waiter, [free, waiter])).toBe(true)
})

test('at most one task leaves an overlapping group per tick', () => {
  const a = task({ task_id: 't1', phase: 'blocked-on-files', files: ['a/'] })
  const b = task({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] })
  expect(releasableFromFiles([a, b]).map((t) => t.task_id)).toEqual(['t1'])
})

test('detectCycle names a cycle', () => {
  const a = task({ task_id: 't1', depends_on: ['t2'] })
  const b = task({ task_id: 't2', depends_on: ['t1'] })
  expect(detectCycle([a, b])).toEqual(['t1', 't2'])
})

test('detectCycle returns null for an acyclic graph', () => {
  const a = task({ task_id: 't1' })
  const b = task({ task_id: 't2', depends_on: ['t1'] })
  expect(detectCycle([a, b])).toBeNull()
})
