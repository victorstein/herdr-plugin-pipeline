import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actionFor, ageMinutes, applyEvents, pickOneAdvance } from '../src/supervisor/tick'
import { isCurrentSchemaRun, makeSettledIdleReader } from '../src/supervisor/main'
import { newRun, saveRun } from '../src/lib/ledger'
import { TASK_ROWS } from '../src/lib/phases'
import type { AgentStatus, QueuedEvent, Run, Task, TaskPhase } from '../src/lib/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tick-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
  phase: 'implement', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
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

test('a pane exit while blocked fails the task and abandons its decisions', () => {
  const run = mkRun([mkTask({
    phase: 'blocked-on-decision',
    decisions: [{
      id: 'd1', asked_at: 1, from_phase: 'implement', question: 'q?', recommendation: 'r',
      answer: null, answered_by: null, answered_at: null, prompted_at: null,
    }],
  })])
  const events: QueuedEvent[] = [
    { kind: 'pane.exited', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7' },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.phase).toBe('failed')
  expect(run.tasks[0]?.decisions[0]?.answered_by).toBe('abandoned')
})

test('an answered but undelivered decision is also abandoned on pane death', () => {
  const run = mkRun([mkTask({
    phase: 'blocked-on-decision',
    pending_answer: 'd1',
    decisions: [{
      id: 'd1', asked_at: 1, from_phase: 'implement', question: 'q?', recommendation: 'r',
      answer: 'go ahead', answered_by: 'orchestrator', answered_at: 2, prompted_at: null,
    }],
  })])
  const events: QueuedEvent[] = [
    { kind: 'pane.exited', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7' },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.phase).toBe('failed')
  expect(run.tasks[0]?.decisions[0]?.answered_by).toBe('abandoned')
})

test('worktree.created records the checkout path and adoption time', () => {
  const run = mkRun([mkTask({ workspace_id: null, branch: 'feat/x', checkout_path: null, adopted_at: null })])
  const events: QueuedEvent[] = [
    {
      kind: 'worktree.created', session: 'personal', at: 1, workspace_id: 'w9', branch: 'feat/x',
      checkout_path: '/r/.worktrees/feat-x', repo_key: 'k', repo_root: '/r', is_linked_worktree: true,
    },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.checkout_path).toBe('/r/.worktrees/feat-x')
  expect(run.tasks[0]?.adopted_at).toBeGreaterThan(0)
})

test('a run without schema_version 2 is never advanced', () => {
  const run = mkRun([mkTask({ phase: 'implement' })])
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  ;(run as { schema_version?: number }).schema_version = undefined
  const before = run.phase

  expect(isCurrentSchemaRun(run)).toBe(false)
  // Mirrors main.ts's own tick: only isCurrentSchemaRun runs ever reach
  // pickOneAdvance, and only picked runs are handed to evaluateRun/advanceTasks —
  // the two functions that ever mutate `phase`.
  const eligible = [run].filter(isCurrentSchemaRun)
  expect(pickOneAdvance(eligible)).toHaveLength(0)
  expect(run.phase).toBe(before)
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

test('ageMinutes floors to whole minutes and never goes negative', () => {
  const now = 10_000_000
  expect(ageMinutes(now - 125_000, now)).toBe(2)
  expect(ageMinutes(now, now)).toBe(0)
  // Clock skew: a future stamp must not print "-1m" at an orchestrator.
  expect(ageMinutes(now + 600_000, now)).toBe(0)
})

test('actionFor answers whose move it is, by rung', () => {
  const run = mkRun([])
  run.run_id = 'r1'
  const at = (phase: TaskPhase, over: Partial<Task> = {}) =>
    actionFor(run, mkTask({ phase, ...over }), 'hp')

  expect(at('done')).toBe('nothing for you — this task is finished')
  for (const phase of ['failed', 'orphaned', 'blocked-on-failure'] as TaskPhase[]) {
    expect(at(phase)).toBe('dead end, needs a human')
  }
  expect(at('escalated', { escalated_from: 'implement' }))
    .toBe('needs a human: `hp rewind r1 implement --task t1`')
  expect(at('escalated', { escalated_from: null }))
    .toBe('needs a human: `hp rewind r1 <phase> --task t1`')
  for (const phase of ['merge', 'close', 'blocked-on-decision'] as TaskPhase[]) {
    expect(at(phase)).toBe('YOUR move')
  }
  for (const phase of ['research', 'spec', 'spec-review', 'plan', 'plan-review',
                       'implement', 'pr-review-intent', 'pr-review-quality'] as TaskPhase[]) {
    expect(at(phase)).toBe("worker's move")
  }
  for (const phase of ['queued', 'ci', 'teardown'] as TaskPhase[]) {
    expect(at(phase)).toBe('nothing for you — the supervisor is driving')
    // Never `intake to be closed`: that is stallAwaiting's run-level `gate`
    // sentence and is false of a queued TASK, which waits on its dependency and
    // file gates. Reusing that map here is what the spec declines.
    expect(at(phase)).not.toContain('intake')
  }
})

test('actionFor renders the CLI it is given, never a literal hpipe', () => {
  // A plugin installed from GitHub has no `hpipe` on PATH (src/lib/render.ts:19-22),
  // so a hardcoded name would be uninvokable. status.ts:25 has that latent defect.
  const run = mkRun([])
  const text = actionFor(run, mkTask({ phase: 'escalated', escalated_from: 'plan' }),
    'bun run /p/src/cli.ts')
  expect(text).toContain('bun run /p/src/cli.ts rewind')
  expect(text).not.toMatch(/(^|[^/])hpipe /)
})

test('a blocked-on-files task held by a dead task names the release command', () => {
  // `failed` and `escalated` both hold files forever (holdsFiles: true), so
  // filesClearFor never goes true and only `hpipe release` clears it. Telling the
  // orchestrator "the supervisor is driving" there is false, permanently.
  for (const holderPhase of ['failed', 'escalated'] as TaskPhase[]) {
    const run = mkRun([])
    const blocked = mkTask({ task_id: 't1', phase: 'blocked-on-files', files: ['src/a.ts'] })
    const holder = mkTask({ task_id: 't2', phase: holderPhase, files: ['src/a.ts'] })
    run.tasks = [blocked, holder]
    expect(actionFor(run, blocked, 'hp')).toBe('YOUR move: `hp release --task t2`')
  }
})

test('a blocked-on-files task held by a live task is still the supervisor\'s', () => {
  // `hpipe release` refuses an in-flight holder, so offering it against a healthy
  // one sends the orchestrator at a command that will bounce (src/lib/status.ts:51-54).
  const run = mkRun([])
  const blocked = mkTask({ task_id: 't1', phase: 'blocked-on-files', files: ['src/a.ts'] })
  const holder = mkTask({ task_id: 't2', phase: 'implement', files: ['src/a.ts'] })
  run.tasks = [blocked, holder]
  expect(actionFor(run, blocked, 'hp')).toBe('nothing for you — the supervisor is driving')
})

test('a blocked-on-files task whose holder touches other files is not blamed on it', () => {
  const run = mkRun([])
  const blocked = mkTask({ task_id: 't1', phase: 'blocked-on-files', files: ['src/a.ts'] })
  const unrelated = mkTask({ task_id: 't2', phase: 'failed', files: ['src/z.ts'] })
  run.tasks = [blocked, unrelated]
  expect(actionFor(run, blocked, 'hp')).toBe('nothing for you — the supervisor is driving')
})

test('actionFor covers every row in TASK_ROWS with a known clause', () => {
  const run = mkRun([])
  const known = new Set([
    'nothing for you — this task is finished',
    'dead end, needs a human',
    "worker's move",
    'YOUR move',
    'nothing for you — the supervisor is driving',
  ])
  for (const row of TASK_ROWS) {
    const task = mkTask({ phase: row.phase, escalated_from: 'implement' })
    run.tasks = [task]
    const clause = actionFor(run, task, 'hp')
    expect(clause.length, `${row.phase} produced an empty clause`).toBeGreaterThan(0)
    const isCommandClause = clause.startsWith('needs a human: `') ||
      clause.startsWith('YOUR move: `')
    expect(known.has(clause) || isCommandClause, `${row.phase} produced: ${clause}`).toBe(true)
  }
})
