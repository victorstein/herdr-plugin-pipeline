import { expect, test } from 'bun:test'
import { detectCycle, filesOverlap, gateStatus } from '../src/lib/gating'
import type { Task } from '../src/lib/types'

const task = (over: Partial<Task>): Task => ({
  task_id: 't', branch: 'b', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'queued', pass: 1, phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, notes: '',
  ...over,
})

test('files overlap on a prefix, not only an exact path', () => {
  expect(filesOverlap(['packages/core/src/db/'], ['packages/core/src/db/usage.ts'])).toBe(true)
  expect(filesOverlap(['apps/api/'], ['packages/core/'])).toBe(false)
})

test('a task with satisfied dependencies and no overlap is ready', () => {
  const done = task({ task_id: 't1', phase: 'done' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [done, waiting])).toEqual({ state: 'ready' })
})

test('a task waits on an unfinished dependency', () => {
  const running = task({ task_id: 't1', phase: 'execute' })
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

test('an in-flight task holding an overlapping file blocks the gate', () => {
  const running = task({ task_id: 't1', phase: 'execute', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', files: ['packages/core/src/db/usage.ts'] })
  expect(gateStatus(waiting, [running, waiting])).toEqual({ state: 'waiting', on: ['t1'] })
})

test('a finished task does not hold its files', () => {
  const done = task({ task_id: 't1', phase: 'done', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', files: ['packages/core/x.ts'] })
  expect(gateStatus(waiting, [done, waiting]).state).toBe('ready')
})

test('an escalated task still holds its files', () => {
  // Nothing tears an escalated task down, so its worktree and unmerged work
  // persist — releasing the lock would let a second task edit the same files.
  const stuck = task({ task_id: 't1', phase: 'escalated', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', files: ['packages/core/x.ts'] })
  expect(gateStatus(waiting, [stuck, waiting]).state).toBe('waiting')
})

test('a failed task still holds its files', () => {
  const dead = task({ task_id: 't1', phase: 'failed', files: ['apps/api/'] })
  const waiting = task({ task_id: 't2', files: ['apps/api/main.ts'] })
  expect(gateStatus(waiting, [dead, waiting]).state).toBe('waiting')
})

test('an orphaned task releases its files, because its code already merged', () => {
  const merged = task({ task_id: 't1', phase: 'orphaned', files: ['apps/api/'] })
  const waiting = task({ task_id: 't2', files: ['apps/api/main.ts'] })
  expect(gateStatus(waiting, [merged, waiting]).state).toBe('ready')
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
