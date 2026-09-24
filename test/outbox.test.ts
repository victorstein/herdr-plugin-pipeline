import { expect, test } from 'bun:test'
import { newRun } from '../src/lib/ledger'
import {
  enqueue, isCurrent, outboxWarnings, pruneOutbox, recipientPane, settleOutbox, UNATTEMPTED_WARN_MS,
} from '../src/lib/outbox'
import type { Run, Task } from '../src/lib/types'

const mkTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'spec', phase_entered_at: 1000, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null, checkout_path: '/r/wt',
  registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function mkRun(): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [mkTask()]
  return run
}

const MINUTE = 60_000

test('a run written before the outbox existed reads as owing nothing', () => {
  const run = mkRun()
  expect(run.outbox).toBeUndefined()
  expect(pruneOutbox(run)).toEqual([])
  expect(outboxWarnings(run, new Set(['w1:p1']))).toEqual([])
})

test('an entry is stamped with its record\'s phase entry and goes stale when the record moves', () => {
  const run = mkRun()
  const entry = enqueue(run, { to: 'worker', taskId: 't1', text: 'write the spec' }, 5000)
  expect(entry.entered_at).toBe(1000)
  expect(isCurrent(run, entry)).toBe(true)

  const task = run.tasks[0] as Task
  task.phase = 'spec-review'
  task.phase_entered_at = 9000
  expect(pruneOutbox(run).map((e) => e.id)).toEqual([entry.id])
  expect(run.outbox).toEqual([])
})

test('a run-level entry follows the run\'s own phase entry', () => {
  const run = mkRun()
  const entry = enqueue(run, { to: 'orchestrator', taskId: null, text: 'review the branch' }, 5000)
  expect(isCurrent(run, entry)).toBe(true)
  run.phase_entered_at += 1
  expect(isCurrent(run, entry)).toBe(false)
})

test('the recipient is resolved by role, so a rebound orchestrator still gets what is owed', () => {
  const run = mkRun()
  const toOrchestrator = enqueue(run, { to: 'orchestrator', taskId: 't1', text: 'dispatch t1' }, 0)
  const toWorker = enqueue(run, { to: 'worker', taskId: 't1', text: 'write the spec' }, 0)
  run.orchestrator_pane = 'w9:p3'
  expect(recipientPane(run, toOrchestrator)).toBe('w9:p3')
  expect(recipientPane(run, toWorker)).toBe('w7:p1')
})

test('settling removes what landed, counts what failed, and drops what never can land', () => {
  const run = mkRun()
  const landed = enqueue(run, { to: 'worker', taskId: 't1', text: 'a' }, 0)
  const failed = enqueue(run, { to: 'worker', taskId: 't1', text: 'b' }, 0)
  const refused = enqueue(run, { to: 'worker', taskId: 't1', text: 'c' }, 0)
  const untouched = enqueue(run, { to: 'orchestrator', taskId: null, text: 'd' }, 0)

  settleOutbox(run, [
    { id: landed.id, ok: true },
    { id: failed.id, ok: false, code: 'agent_not_found' },
    { id: refused.id, ok: false, code: 'empty_agent_prompt', permanent: true },
  ], 7000)

  expect(run.outbox?.map((e) => e.id)).toEqual([failed.id, untouched.id])
  expect(run.outbox?.[0]).toMatchObject({ attempts: 1, last_code: 'agent_not_found', last_attempt_at: 7000 })
  expect(run.outbox?.[1]?.attempts).toBe(0)
})

test('settling a fresh copy that no longer holds the entry is a no-op', () => {
  const run = mkRun()
  settleOutbox(run, [{ id: 'gone', ok: true }], 0)
  expect(run.outbox).toBeUndefined()
})

test('status names a recipient whose prompts keep failing, with the age and the last code', () => {
  const run = mkRun()
  const entry = enqueue(run, { to: 'orchestrator', taskId: null, text: 'x' }, 0)
  settleOutbox(run, [{ id: entry.id, ok: false, code: 'agent_not_found' }], MINUTE)
  settleOutbox(run, [{ id: entry.id, ok: false, code: 'agent_not_found' }], 2 * MINUTE)

  const [line, ...rest] = outboxWarnings(run, new Set(['w1:p1', 'w7:p1']), 42 * MINUTE)
  expect(rest).toEqual([])
  expect(line).toContain('1 prompt for the orchestrator undelivered for 42m')
  expect(line).toContain('2 failed attempts, last agent_not_found')
})

test('status says a pane is stuck on someone else\'s input, and how to free it', () => {
  const run = mkRun()
  const entry = enqueue(run, { to: 'orchestrator', taskId: null, text: 'x' }, 0)
  settleOutbox(run, [{ id: entry.id, ok: false, code: 'stuck_input' }], MINUTE)
  const [line] = outboxWarnings(run, new Set(['w1:p1']), 3 * MINUTE)
  expect(line).toContain('stuck input in w1:p1: 1 prompt for the orchestrator held 3m')
  expect(line).toContain('submit or clear that text')
})

test('status names a gone pane even before any attempt, since nothing is being tried', () => {
  const run = mkRun()
  enqueue(run, { to: 'worker', taskId: 't1', text: 'a' }, 0)
  enqueue(run, { to: 'worker', taskId: 't1', text: 'b' }, 0)
  const [line] = outboxWarnings(run, new Set(['w1:p1']), 5 * MINUTE)
  expect(line).toContain("2 prompts for t1's worker undelivered for 5m (pane w7:p1 is gone)")
})

test('a failed pane list is not read as every pane being gone', () => {
  const run = mkRun()
  enqueue(run, { to: 'worker', taskId: 't1', text: 'a' }, 0)
  expect(outboxWarnings(run, new Set(), MINUTE)).toEqual([])
})

test('a prompt not yet attempted to a live pane is in flight, not held', () => {
  const run = mkRun()
  enqueue(run, { to: 'worker', taskId: 't1', text: 'a' }, 0)
  expect(outboxWarnings(run, new Set(['w1:p1', 'w7:p1']), MINUTE)).toEqual([])
})

test('a prompt never attempted past the threshold is named, so a stalled supervisor is not silent', () => {
  const run = mkRun()
  enqueue(run, { to: 'worker', taskId: 't1', text: 'a' }, 0)
  const [line] = outboxWarnings(run, new Set(['w1:p1', 'w7:p1']), UNATTEMPTED_WARN_MS)
  expect(line).toContain("1 prompt for t1's worker queued 2m and never attempted")
})

test('a finished run owes nothing, whatever is left in its outbox', () => {
  const run = mkRun()
  enqueue(run, { to: 'orchestrator', taskId: null, text: 'a' }, 0)
  run.phase = 'done'
  expect(outboxWarnings(run, new Set(['w1:p1']), MINUTE)).toEqual([])
})
