import { expect, test } from 'bun:test'
import { CI_SETTLE_MS, ciTransitions } from '../src/supervisor/ci'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'ci', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: 5, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function mkRun(tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

const NOW = 1_000_000_000
const head = (bucket: 'pass' | 'fail' | 'pending', headSha = 'aaa') => async () => ({ bucket, headSha })

test('records a bucket change and reports it', async () => {
  const run = mkRun([mkTask({ ci: null, ci_head: { sha: 'aaa', seen_at: NOW - CI_SETTLE_MS } })])
  const changes = await ciTransitions([run], head('pass'), NOW)
  expect(run.tasks[0]?.ci).toBe('pass')
  expect(changes).toHaveLength(1)
})

test('an unchanged bucket is not a transition', async () => {
  const run = mkRun([mkTask({ ci: 'pending' })])
  expect(await ciTransitions([run], head('pending'), NOW)).toHaveLength(0)
})

test('a gh failure never overwrites a known bucket', async () => {
  const run = mkRun([mkTask({ ci: 'pass' })])
  await ciTransitions([run], async () => null, NOW)
  expect(run.tasks[0]?.ci).toBe('pass')
})

test('only tasks in the ci phase with a PR are polled', async () => {
  const run = mkRun([mkTask({ phase: 'implement' }), mkTask({ task_id: 't2', pr: null })])
  let polls = 0
  await ciTransitions([run], async () => { polls++; return { bucket: 'pass', headSha: 'aaa' } }, NOW)
  expect(polls).toBe(0)
})

test('green on a head first seen moments ago is pending: its build may not exist yet — #16', async () => {
  // berean-os t1 cleared ci in 10s: the head's build was still queued and only an
  // older, finished check was listed. Measured on a live run.
  const run = mkRun([mkTask({ ci: null })])
  await ciTransitions([run], head('pass'), NOW)
  expect(run.tasks[0]?.ci).toBe('pending')
  expect(run.tasks[0]?.ci_head).toEqual({ sha: 'aaa', seen_at: NOW })

  await ciTransitions([run], head('pass'), NOW + CI_SETTLE_MS - 1)
  expect(run.tasks[0]?.ci).toBe('pending')
  await ciTransitions([run], head('pass'), NOW + CI_SETTLE_MS)
  expect(run.tasks[0]?.ci).toBe('pass')
})

test('a new head starts the settling over, whatever was recorded for the last one', async () => {
  const run = mkRun([mkTask({ ci: 'pending', ci_head: { sha: 'aaa', seen_at: NOW - 10 * CI_SETTLE_MS } })])
  await ciTransitions([run], head('pass', 'bbb'), NOW)
  expect(run.tasks[0]?.ci).toBe('pending')
  expect(run.tasks[0]?.ci_head).toEqual({ sha: 'bbb', seen_at: NOW })
})

test('red is red at once: a failed check on this head needs no settling', async () => {
  const run = mkRun([mkTask({ ci: null })])
  await ciTransitions([run], head('fail'), NOW)
  expect(run.tasks[0]?.ci).toBe('fail')
})

test('a single-PR run in ship-ci is polled on its batch PR, with the same settle and head reset as a task', async () => {
  const { withBatch } = await import('../src/lib/ledger')
  const { batchFixture } = await import('./helpers/batch')
  const run = withBatch(mkRun([]), batchFixture({ pr: 301 }))
  run.phase = 'ship-ci'
  const polled: number[] = []
  const poll = (bucket: 'pass' | 'fail', sha: string) => async (pr: number) => { polled.push(pr); return { bucket, headSha: sha } }

  await ciTransitions([run], poll('pass', 'h1'), NOW)
  expect(run.batch?.ci).toBe('pending')
  expect(run.batch?.ci_head).toEqual({ sha: 'h1', seen_at: NOW })
  await ciTransitions([run], poll('pass', 'h1'), NOW + CI_SETTLE_MS)
  expect(run.batch?.ci).toBe('pass')
  await ciTransitions([run], poll('pass', 'h2'), NOW + CI_SETTLE_MS + 1)
  expect(run.batch?.ci).toBe('pending')
  expect(polled).toEqual([301, 301, 301])

  const noPr = withBatch(mkRun([]), batchFixture())
  noPr.phase = 'ship-ci'
  await ciTransitions([noPr], poll('fail', 'h1'), NOW)
  expect(noPr.batch?.ci).toBeNull()
})
