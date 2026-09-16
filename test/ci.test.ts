import { expect, test } from 'bun:test'
import { ciTransitions } from '../src/supervisor/ci'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'ci', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: 5, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, notes: '',
  ...over,
})

function mkRun(tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

test('records a bucket change and reports it', async () => {
  const run = mkRun([mkTask({ ci: null })])
  const changes = await ciTransitions([run], async () => 'pass')
  expect(run.tasks[0]?.ci).toBe('pass')
  expect(changes).toHaveLength(1)
})

test('an unchanged bucket is not a transition', async () => {
  const run = mkRun([mkTask({ ci: 'pending' })])
  expect(await ciTransitions([run], async () => 'pending')).toHaveLength(0)
})

test('unknown never overwrites a known bucket', async () => {
  const run = mkRun([mkTask({ ci: 'pass' })])
  await ciTransitions([run], async () => 'unknown')
  expect(run.tasks[0]?.ci).toBe('pass')
})

test('only tasks in the ci phase with a PR are polled', async () => {
  const run = mkRun([mkTask({ phase: 'implement' }), mkTask({ task_id: 't2', pr: null })])
  let polls = 0
  await ciTransitions([run], async () => { polls++; return 'pass' })
  expect(polls).toBe(0)
})
