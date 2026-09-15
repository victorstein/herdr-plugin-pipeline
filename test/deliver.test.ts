import { expect, test } from 'bun:test'
import { artifactPathFor, buildDigest, nextDelivery, shouldRetry } from '../src/supervisor/deliver'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'execute', pass: 1, phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, notes: '',
  ...over,
})

function mkRun(): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  return run
}

test('the digest carries the run id, the event lines, and the next prompt', () => {
  const text = buildDigest({
    run: mkRun(),
    eventLines: ['- feat/x (#1, t1) done, PR #412 open'],
    phaseNote: ' → task-review-spec',
    nextPrompt: 'REVIEW THIS',
  })
  expect(text).toContain('[pipeline] run')
  expect(text).toContain('1 events')
  expect(text).toContain('feat/x (#1, t1) done')
  expect(text).toContain('REVIEW THIS')
})

test('a digest with no phase change still delivers the events', () => {
  const text = buildDigest({
    run: mkRun(), eventLines: ['- feat/x (#1, t1) blocked'], phaseNote: '', nextPrompt: '',
  })
  expect(text).toContain('blocked')
})

test('nextDelivery skips a run with no orchestrator pane', () => {
  const run = mkRun()
  run.orchestrator_pane = null
  expect(nextDelivery([{ run, eventLines: ['x'], phaseNote: '', nextPrompt: '' }])).toBeNull()
})

test('nextDelivery returns the first deliverable payload', () => {
  const run = mkRun()
  const picked = nextDelivery([{ run, eventLines: ['x'], phaseNote: '', nextPrompt: '' }])
  expect(picked?.paneId).toBe('w1:p1')
})

test('agent_blocked is retryable below the cap', () => {
  expect(shouldRetry('agent_blocked', 1, 5)).toBe(true)
})

test('retries stop at the cap', () => {
  expect(shouldRetry('agent_blocked', 5, 5)).toBe(false)
})

test('an unknown pane is retryable — it may be restoring', () => {
  expect(shouldRetry('pane_not_found', 1, 5)).toBe(true)
})

test('a blocked worker line inlines its pane tail', () => {
  const run = mkRun()
  run.tasks.push(mkTask({ agent_status: 'blocked' }))
  const text = buildDigest({
    run,
    eventLines: ['- feat/x (#1, t1) blocked', '    "Do you want to proceed?"'],
    phaseNote: '', nextPrompt: '',
  })
  expect(text).toContain('Do you want to proceed?')
})

import { isAgentReady } from '../src/lib/machine'

test('an agent that finished its turn is ready, whether idle or done', () => {
  // herdr reports `done` for "idle and not yet seen". An orchestrator driven by
  // this plugin is never seen by a human, so `done` is its normal resting state
  // — treating only `idle` as ready stalls every run at its first phase.
  expect(isAgentReady('idle')).toBe(true)
  expect(isAgentReady('done')).toBe(true)
})

test('an agent still working or blocked is not ready', () => {
  expect(isAgentReady('working')).toBe(false)
  expect(isAgentReady('blocked')).toBe(false)
  expect(isAgentReady('unknown')).toBe(false)
})

test('the plan phase resolves an artifact path even though cmdStart never seeds artifacts.plan', () => {
  const run = mkRun()
  run.phase = 'plan'
  expect(run.artifacts.plan).toBeNull()
  expect(artifactPathFor(run, null)).toBe('docs/superpowers/plans/plan.md')
})

test('a seeded artifacts.plan wins over the default', () => {
  const run = mkRun()
  run.phase = 'plan'
  run.artifacts.plan = 'docs/superpowers/plans/custom.md'
  expect(artifactPathFor(run, null)).toBe('docs/superpowers/plans/custom.md')
})
