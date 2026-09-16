import { expect, test } from 'bun:test'
import { runTeardown, SETTLED } from '../src/supervisor/teardown'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'teardown', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: 5, ci: 'pass',
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function mkRun(tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

test('removes the worktree and marks the task done', async () => {
  const run = mkRun([mkTask({})])
  const removed: string[] = []
  await runTeardown([run], async (ws) => { removed.push(ws); return true })
  expect(removed).toEqual(['w7'])
  expect(run.tasks[0]?.phase).toBe('done')
})

test('keep_worktree skips removal but still completes the task', async () => {
  const run = mkRun([mkTask({ keep_worktree: true })])
  const removed: string[] = []
  await runTeardown([run], async (ws) => { removed.push(ws); return true })
  expect(removed).toEqual([])
  expect(run.tasks[0]?.phase).toBe('done')
})

test('a failed removal marks the task orphaned rather than done', async () => {
  const run = mkRun([mkTask({})])
  await runTeardown([run], async () => false)
  expect(run.tasks[0]?.phase).toBe('orphaned')
})

test('is idempotent — an already-done task is not torn down twice', async () => {
  const run = mkRun([mkTask({ phase: 'done' })])
  let calls = 0
  await runTeardown([run], async () => { calls++; return true })
  expect(calls).toBe(0)
})

test('SETTLED counts escalated, which is not terminal but has stopped moving', () => {
  expect(SETTLED.has('escalated')).toBe(true)
  expect(SETTLED.has('done')).toBe(true)
  expect(SETTLED.has('implement')).toBe(false)
})
