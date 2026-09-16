import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEvents, pickOneAdvance } from '../src/supervisor/tick'
import { makeSettledIdleReader } from '../src/supervisor/main'
import { newRun, saveRun } from '../src/lib/ledger'
import type { AgentStatus, QueuedEvent, Run, Task } from '../src/lib/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tick-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
  phase: 'implement', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, notes: '',
  ...over,
})

function mkRun(tasks: Task[]): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

test('an agent_status event updates the matching task', () => {
  const run = mkRun([mkTask({})])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'idle' },
  ]
  const { changed } = applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.agent_status).toBe('idle')
  expect(changed).toBe(true)
})

test('events for another session are ignored', () => {
  const run = mkRun([mkTask({})])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'default', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'idle' },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.agent_status).toBe('working')
})

test('an orchestrator pane event never wakes anything', () => {
  const run = mkRun([mkTask({})])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'personal', at: 1, pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' },
  ]
  const { wake } = applyEvents([run], events, 'personal', new Set(['w1:p1']))
  expect(wake).toHaveLength(0)
})

test('a repeated status is deduped', () => {
  const run = mkRun([mkTask({ agent_status: 'idle' })])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'idle' },
  ]
  const { wake } = applyEvents([run], events, 'personal', new Set())
  expect(wake).toHaveLength(0)
})

test('pane.exited marks the task failed when it has no PR', () => {
  const run = mkRun([mkTask({ pr: null })])
  const events: QueuedEvent[] = [
    { kind: 'pane.exited', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7' },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.phase).toBe('failed')
})

test('an agent release also fails the task', () => {
  const run = mkRun([mkTask({})])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_detected', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', released: true },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.phase).toBe('failed')
})

test('worktree.created binds a workspace to the matching branch', () => {
  const run = mkRun([mkTask({ workspace_id: null, branch: 'feat/x' })])
  const events: QueuedEvent[] = [
    { kind: 'worktree.created', session: 'personal', at: 1, workspace_id: 'w9', branch: 'feat/x', repo_key: 'k', repo_root: '/r', is_linked_worktree: true },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.workspace_id).toBe('w9')
})

test('pickOneAdvance returns at most one candidate per orchestrator', () => {
  const run = mkRun([
    mkTask({ task_id: 't1', phase: 'pr-review-intent' }),
    mkTask({ task_id: 't2', phase: 'pr-review-quality' }),
  ])
  run.orchestrator_pane = 'w1:p1'
  const picked = pickOneAdvance([run])
  expect(picked).toHaveLength(1)
})

test('a finished run does not starve a later run sharing its orchestrator pane', () => {
  const finished = mkRun([])
  finished.phase = 'done'
  finished.orchestrator_pane = 'w1:p1'

  const active = mkRun([])
  active.phase = 'intake'
  active.orchestrator_pane = 'w1:p1'

  // listRuns sorts deterministically, so without a phase filter the finished run
  // wins the pane forever and its successor is never evaluated.
  const picked = pickOneAdvance([finished, active])
  expect(picked).toHaveLength(1)
  expect(picked[0]?.phase).toBe('intake')
})

test('two runs on different panes are both picked', () => {
  const a = mkRun([]); a.orchestrator_pane = 'w1:p1'
  const b = mkRun([]); b.orchestrator_pane = 'w2:p1'
  expect(pickOneAdvance([a, b])).toHaveLength(2)
})

test('an escalated run does not starve a later run sharing its pane', () => {
  // Same class as the `done` case: escalated never clears orchestrator_pane and
  // needs a human `hpipe rewind` to leave, so it would hold the pane forever.
  const stuck = mkRun([])
  stuck.phase = 'escalated'
  stuck.orchestrator_pane = 'w1:p1'

  const active = mkRun([])
  active.phase = 'intake'
  active.orchestrator_pane = 'w1:p1'

  const picked = pickOneAdvance([stuck, active])
  expect(picked).toHaveLength(1)
  expect(picked[0]?.phase).toBe('intake')
})

test('settle windows for distinct panes run concurrently, not serially', async () => {
  const settleMs = 200
  const status = async () => 'idle' as const
  const idle = makeSettledIdleReader(['w1:p1', 'w7:p1', 'w8:p1'], settleMs, status)
  const started = Date.now()
  await Promise.all(['w1:p1', 'w7:p1', 'w8:p1'].map((p) => idle(p)))
  // Serial would be ~600ms. Concurrent is ~200ms. Generous slack for CI.
  expect(Date.now() - started).toBeLessThan(settleMs * 2)
})

test('a pane consulted by several rows is polled once, not once per row', async () => {
  const reads: string[] = []
  const status = async (pane: string) => { reads.push(pane); return 'idle' as const }
  const idle = makeSettledIdleReader(['w7:p1'], 10, status)

  expect(await idle('w7:p1')).toBe(true)
  expect(await idle('w7:p1')).toBe(true)
  expect(reads).toEqual(['w7:p1', 'w7:p1'])
})

test('a pane that reads idle then working is not ready', async () => {
  const statuses: AgentStatus[] = ['idle', 'working']
  const status = async () => statuses.shift() ?? 'working'
  const idle = makeSettledIdleReader(['w7:p1'], 10, status)

  expect(await idle('w7:p1')).toBe(false)
  expect(statuses).toHaveLength(0)
})

test('a pane outside the tick\'s roster is not ready rather than a crash', async () => {
  const idle = makeSettledIdleReader(['w7:p1'], 10, async () => 'idle' as const)
  expect(await idle('w9:p1')).toBe(false)
})

test('panes awaited one after another still share a single settle window', async () => {
  // advanceTasks consults liveIdle row by row, so eager construction — not
  // Promise.all at the call site — is what keeps the windows overlapping.
  const settleMs = 200
  const panes = ['w1:p1', 'w7:p1', 'w8:p1']
  const idle = makeSettledIdleReader(panes, settleMs, async () => 'idle' as const)
  const started = Date.now()
  for (const pane of panes) expect(await idle(pane)).toBe(true)
  expect(Date.now() - started).toBeLessThan(settleMs * 2)
})
