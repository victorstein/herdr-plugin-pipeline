import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyEvents, describeWake, type EventSaveDeps, parkedFooter, pickOneAdvance,
  saveEventedRuns, type WakeLine,
} from '../src/supervisor/tick'
import { actionFor, ageMinutes } from '../src/lib/status'
import { isCurrentSchemaRun, makeSettledIdleReader, refreshingIdleReader } from '../src/supervisor/main'
import { loadRun, newRun, saveRun, StaleRunError } from '../src/lib/ledger'
import { TASK_ROWS } from '../src/lib/phases'
import { overdueUnstartedWorker, UNSTARTED_GRACE_MS } from '../src/lib/unstarted'
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

test('only a positive working reading settles an awaited brief — #89', () => {
  const statusEvent = (agent_status: AgentStatus): QueuedEvent[] => [
    { kind: 'pane.agent_status_changed', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', agent_status },
  ]
  for (const status of ['unknown', 'blocked', 'idle', 'done'] as AgentStatus[]) {
    const run = mkRun([mkTask({ phase: 'research', agent_status: 'working', awaiting_brief: true })])
    applyEvents([run], statusEvent(status), 'personal', new Set())
    expect(run.tasks[0]?.awaiting_brief, status).toBe(true)
  }
  const run = mkRun([mkTask({ phase: 'research', agent_status: 'idle', awaiting_brief: true })])
  applyEvents([run], statusEvent('working'), 'personal', new Set())
  expect(run.tasks[0]?.awaiting_brief).toBeUndefined()
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

test('worktree.opened binds a surviving checkout exactly as worktree.created does — #94', () => {
  const run = mkRun([mkTask({ workspace_id: null, pane_id: null, branch: 'feat/x', adopted_at: null })])
  const events: QueuedEvent[] = [{
    kind: 'worktree.opened', session: 'personal', at: 1, workspace_id: 'w9', branch: 'feat/x',
    checkout_path: '/r/.worktrees/feat-x',
  }]
  expect(applyEvents([run], events, 'personal', new Set()).changed).toBe(true)
  expect(run.tasks[0]?.workspace_id).toBe('w9')
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

test('a run held in execute only by escalated tasks does not starve a run sharing its pane', () => {
  const held = mkRun([
    mkTask({ task_id: 't1', phase: 'done' }),
    mkTask({ task_id: 't2', phase: 'escalated', escalated_from: 'implement' }),
  ])
  held.phase = 'execute'
  held.intake_closed = true
  held.orchestrator_pane = 'w1:p1'

  const active = mkRun([])
  active.phase = 'intake'
  active.orchestrator_pane = 'w1:p1'

  expect(pickOneAdvance([held, active])).toEqual([active])
})

test('a held run is picked again once its escalated task is rewound', () => {
  const held = mkRun([mkTask({ task_id: 't1', phase: 'escalated', escalated_from: 'implement' })])
  held.phase = 'execute'
  held.intake_closed = true
  held.orchestrator_pane = 'w1:p1'
  expect(pickOneAdvance([held])).toHaveLength(0)

  ;(held.tasks[0] as Task).phase = 'implement'
  expect(pickOneAdvance([held])).toEqual([held])
})

test('an escalated task beside live work, or before intake closes, keeps its run picked', () => {
  const live = mkRun([
    mkTask({ task_id: 't1', phase: 'implement' }),
    mkTask({ task_id: 't2', phase: 'escalated', escalated_from: 'implement' }),
  ])
  live.phase = 'execute'
  live.intake_closed = true
  live.orchestrator_pane = 'w1:p1'
  expect(pickOneAdvance([live])).toEqual([live])

  const open = mkRun([mkTask({ task_id: 't1', phase: 'escalated', escalated_from: 'implement' })])
  open.phase = 'execute'
  open.intake_closed = false
  open.orchestrator_pane = 'w2:p1'
  expect(pickOneAdvance([open])).toEqual([open])
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
    .toBe('needs a human: `hp rewind r1 implement --task t1` resumes it, `hp rewind r1 failed --task t1` abandons it — the run holds in execute until one is run')
  expect(at('escalated', { escalated_from: null }))
    .toBe('needs a human: `hp rewind r1 <phase> --task t1` resumes it, `hp rewind r1 failed --task t1` abandons it — the run holds in execute until one is run')
  // #95: the same noun phrase the stall probe uses, so the three channels agree.
  expect(at('merge', { pr: 7 })).toBe('YOUR move: waiting for PR #7 to be merged')
  expect(at('close')).toBe('YOUR move: waiting for issue #1 to close')
  expect(at('blocked-on-decision')).toBe('YOUR move: waiting for an answer to the open decision')
  expect(at('blocked-on-decision', { pending_answer: 'd1' }))
    .toBe('nothing for you — waiting for its recorded answer to reach the worker')
  expect(at('research', { awaiting_brief: true, pane_id: null }))
    .toBe('YOUR move: no agent has been started for it yet — start one, then `hp dispatch --task t1 --pane <pane>`')
  expect(at('research')).toBe("worker's move: waiting for its research artifact")
  expect(at('plan')).toBe("worker's move: waiting for its plan artifact")
  expect(at('spec-review')).toBe("worker's move: waiting for its review verdict")
  expect(at('implement')).toBe("worker's move: waiting for a pushed PR for feat/x (#1)")
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
  // so a hardcoded name would be uninvokable.
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
  // one sends the orchestrator at a command that will bounce.
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

test('every row in TASK_ROWS gets a clause that matches who its actor is', () => {
  // Keyed on what `actor` MEANS, not on actionFor's own branch order. An earlier
  // version asserted membership in a set of known strings, which rung 7's
  // unconditional catch-all makes unfalsifiable: a new `actor: 'human'` row would
  // land on "the supervisor is driving" — false for a human-owned row — and still
  // pass. This fails for that row instead.
  const run = mkRun([])
  for (const row of TASK_ROWS) {
    const task = mkTask({ phase: row.phase, escalated_from: 'implement' })
    run.tasks = [task]
    const clause = actionFor(run, task, 'hp')
    const where = `${row.phase} produced: ${clause}`

    expect(clause.length, `${row.phase} produced an empty clause`).toBeGreaterThan(0)
    if (row.terminal === true) {
      expect(clause, where).not.toContain('move')
    } else if (row.actor === 'human') {
      expect(clause, where).toContain('needs a human')
    } else if (row.actor === 'orchestrator') {
      expect(clause, where).toStartWith('YOUR move: waiting for ')
    } else if (row.actor === 'worker') {
      expect(clause, where).toStartWith("worker's move: waiting for ")
    } else {
      expect(clause, where).toContain('nothing for you')
    }
  }
})

test('a status wake line carries the scoped trigger and the phase at the event', () => {
  const run = mkRun([mkTask({ phase: 'implement' })])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'done' },
  ]
  const { wake } = applyEvents([run], events, 'personal', new Set())
  expect(wake[0]?.event).toBe('agent:done')
  expect(wake[0]?.phaseAtEvent).toBe('implement')
})

test('a pane exit reports the phase it left, not the failed phase it was just put in', () => {
  // applyEvents forces `failed` before pushing, so capturing after the transition
  // would render "failed → failed" and lose what the task was actually doing.
  const run = mkRun([mkTask({ phase: 'implement', pr: null })])
  const events: QueuedEvent[] = [
    { kind: 'pane.exited', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7' },
  ]
  const { wake } = applyEvents([run], events, 'personal', new Set())
  expect(wake[0]?.phaseAtEvent).toBe('implement')
  expect(wake[0]?.event).toBe('pane exited, no PR')
  expect(run.tasks[0]?.phase).toBe('failed')
})

test('a released agent reports the phase it left', () => {
  const run = mkRun([mkTask({ phase: 'spec' })])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_detected', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', released: true },
  ]
  const { wake } = applyEvents([run], events, 'personal', new Set())
  expect(wake[0]?.event).toBe('agent released')
  expect(wake[0]?.phaseAtEvent).toBe('spec')
})

test('two status events for one task in one drain produce two separately-keyed lines', () => {
  // The gate main.ts uses for the pane tail keys off `event`, not
  // `task.agent_status` — that field is overwritten by the second event in the
  // same drain, so a per-task gate attaches the tail to the wrong line.
  const run = mkRun([mkTask({ phase: 'implement' })])
  const at = (agent_status: AgentStatus): QueuedEvent =>
    ({ kind: 'pane.agent_status_changed', session: 'personal', at: 1,
       pane_id: 'w7:p1', workspace_id: 'w7', agent_status })
  const { wake } = applyEvents([run], [at('blocked'), at('idle')], 'personal', new Set())
  expect(wake.map((w) => w.event)).toEqual(['agent:blocked', 'agent:idle'])
  // The point: `task.agent_status` is `idle` for BOTH lines, so the old per-task
  // gate could not have told them apart.
  expect(run.tasks[0]?.agent_status).toBe('idle')
})

const wakeLine = (over: Partial<WakeLine>): WakeLine => {
  const run = mkRun([])
  run.run_id = 'r1'
  return { run, task: mkTask({}), event: 'agent:idle', phaseAtEvent: 'implement', ...over }
}

test('a digest line carries the task, the phase, the age and the action', () => {
  const now = 1_000_000
  const line = wakeLine({ task: mkTask({ phase: 'implement', phase_entered_at: now - 720_000 }) })
  expect(describeWake(line, now, 'hp'))
    .toBe("t1 feat/x (#1) [implement 12m] agent:idle — worker's move: waiting for a pushed PR for feat/x (#1)")
})

test('a digest line names the missing artifact of an idle worker', () => {
  const now = 1_000_000
  const entered = now - 720_000
  const line = wakeLine({
    phaseAtEvent: 'research',
    task: mkTask({
      phase: 'research', phase_entered_at: entered,
      artifact_missing: { at: entered, path: '/wt/r.md', candidates: ['a.md', 'b.md'] },
    }),
  })
  expect(describeWake(line, now, 'hp')).toBe(
    't1 feat/x (#1) [research 12m] agent:idle — YOUR move: worker idle with nothing at /wt/r.md ' +
    '(2 candidates, too many to adopt: a.md, b.md)',
  )
})

test('a phase that moved this tick renders as a transition and drops the age', () => {
  // Every in-tick mutator re-stamps phase_entered_at, so the age would read 0m in
  // every arrow line. The arrow is the signal that the phase actually completed.
  const now = 1_000_000
  const line = wakeLine({
    phaseAtEvent: 'research',
    task: mkTask({ phase: 'spec', phase_entered_at: now }),
  })
  expect(describeWake(line, now, 'hp'))
    .toBe("t1 feat/x (#1) [research → spec] agent:idle — worker's move: waiting for its spec artifact")
})

test('a blocked line indents its pane tail four spaces under the bullet', () => {
  const now = 1_000_000
  const line = wakeLine({
    event: 'agent:blocked',
    detail: 'Do you want to proceed?\nyes / no',
    task: mkTask({ phase: 'plan', phase_entered_at: now }),
  })
  expect(describeWake(line, now, 'hp')).toBe(
    "t1 feat/x (#1) [implement → plan] agent:blocked — worker's move: waiting for its plan artifact\n" +
    '    Do you want to proceed?\n' +
    '    yes / no',
  )
})

test('a run-level wake line renders without an action rung', () => {
  // Unreachable today — all three push sites have a task — so this is a
  // characterisation test guarding the defensive branch.
  const now = 1_000_000
  const run = mkRun([])
  run.run_id = 'r1'
  run.phase = 'execute'
  run.phase_entered_at = now - 60_000
  const text = describeWake(
    { run, task: null, event: 'agent:idle', phaseAtEvent: 'execute' }, now, 'hp')
  expect(text).toBe('r1 [execute 1m] agent:idle')
})

test('main declares hpipe once, above the run loop that renders digest lines', async () => {
  // A source-text guard because nothing else catches this: `main()` runs only
  // under import.meta.main so no test executes its tick body, and tsc does not
  // flag a temporal-dead-zone read from inside a loop body. Hoisting this
  // binding while leaving the original in place put the only declaration BELOW
  // its first use, which throws ReferenceError on every tick into the per-run
  // catch — a dead supervisor that still logs as if it were driving.
  const src = await Bun.file(join(import.meta.dir, '..', 'src', 'supervisor', 'main.ts')).text()
  const declarations = [...src.matchAll(/const hpipe = hpipeCommand\(/g)]
  expect(declarations).toHaveLength(1)
  expect(declarations[0]?.index).toBeLessThan(src.indexOf('describeWake('))
})

test('the footer names orchestrator-owned and escalated tasks that produced no line', () => {
  const now = 1_000_000
  const run = mkRun([])
  run.run_id = 'r1'
  // Declared out of order on purpose: with these already sorted the sort never
  // has to do anything and deleting it leaves the suite green.
  run.tasks = [
    mkTask({ task_id: 't2', branch: 'fix/b', issue: 31, phase: 'escalated',
             escalated_from: 'plan', phase_entered_at: now - 3_780_000 }),
    mkTask({ task_id: 't1', branch: 'fix/a', issue: 30, phase: 'merge', pr: 41,
             phase_entered_at: now - 2_460_000 }),
  ]
  expect(parkedFooter(run, new Set(), now, 'hp')).toBe(
    'also waiting on you:\n' +
    '- t1 fix/a (#30) [merge 41m] — YOUR move: waiting for PR #41 to be merged\n' +
    '- t2 fix/b (#31) [escalated 63m] — needs a human: `hp rewind r1 plan --task t2` resumes it, `hp rewind r1 failed --task t2` abandons it — the run holds in execute until one is run',
  )
})

test('a task already named in the digest is not repeated in the footer', () => {
  const now = 1_000_000
  const run = mkRun([mkTask({ task_id: 't1', phase: 'merge', phase_entered_at: now })])
  expect(parkedFooter(run, new Set(['t1']), now, 'hp')).toBe('')
})

test('worker-owned, no-actor and terminal rows are not the footer\'s business', () => {
  const now = 1_000_000
  const run = mkRun([])
  for (const phase of ['research', 'implement', 'queued', 'ci', 'teardown', 'blocked-on-files',
                       'done', 'failed', 'orphaned', 'blocked-on-failure'] as TaskPhase[]) {
    run.tasks = [mkTask({ phase })]
    expect(parkedFooter(run, new Set(), now, 'hp'), `${phase} must not be listed`).toBe('')
  }
})

test('the footer is empty for a run with no tasks', () => {
  expect(parkedFooter(mkRun([]), new Set(), 1_000_000, 'hp')).toBe('')
})

test('the footer renders the CLI it is given, and covered beats the escalated exception', () => {
  const now = 1_000_000
  const run = mkRun([])
  run.run_id = 'r1'
  run.tasks = [mkTask({ task_id: 't1', phase: 'escalated', escalated_from: 'plan',
                        phase_entered_at: now })]
  expect(parkedFooter(run, new Set(), now, 'bun run /p/src/cli.ts'))
    .toContain('bun run /p/src/cli.ts rewind r1 plan --task t1')
  expect(parkedFooter(run, new Set(['t1']), now, 'hp')).toBe('')
})

test('the footer lists every non-terminal row a person has to act on', () => {
  // Keyed on `actor`, deliberately NOT on the shared `waitsOnYou` predicate the
  // footer uses — which spells the human case as `phase === 'escalated'`. A second
  // actor:'human' row would diverge and this goes red, which is the whole point of
  // a table-driven guard.
  const now = 1_000_000
  const run = mkRun([])
  for (const row of TASK_ROWS) {
    const needsAPerson = row.actor === 'orchestrator' || row.actor === 'human'
    const expected = row.terminal !== true && needsAPerson
    run.tasks = [mkTask({ phase: row.phase, escalated_from: 'implement' })]
    const listed = parkedFooter(run, new Set(), now, 'hp').length > 0
    expect(listed, `${row.phase}: expected listed=${expected}`).toBe(expected)
  }
})

const exitEvents: QueuedEvent[] = [
  { kind: 'pane.exited', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7' },
]

const eventSaveDeps = (warnings: string[] = []): EventSaveDeps => ({
  save: (r) => saveRun(dir, r),
  reload: (r) => loadRun(dir, r.session, r.run_id),
  reapply: (r) => applyEvents([r], exitEvents, 'personal', new Set()),
  warn: (m) => { warnings.push(m) },
})

test('an event batch is re-applied onto a run a CLI command rewrote mid-tick', async () => {
  const run = mkRun([mkTask({})])
  await saveRun(dir, run)
  const tickCopy = (await loadRun(dir, 'personal', run.run_id))!
  const applied = applyEvents([tickCopy], exitEvents, 'personal', new Set())

  const cliCopy = (await loadRun(dir, 'personal', run.run_id))!
  cliCopy.intake_closed = true
  await saveRun(dir, cliCopy)

  const result = await saveEventedRuns([tickCopy], applied.wake, eventSaveDeps())

  const onDisk = (await loadRun(dir, 'personal', run.run_id))!
  expect(onDisk.intake_closed).toBe(true)
  expect(onDisk.tasks[0]?.phase).toBe('failed')
  expect(result.runs).toHaveLength(1)
  expect(result.runs[0]).not.toBe(tickCopy)
  expect(result.wake).toHaveLength(1)
  expect(result.wake[0]?.run).toBe(result.runs[0]!)
})

test('an uncontended event batch saves the copy the tick already holds', async () => {
  const run = mkRun([mkTask({})])
  await saveRun(dir, run)
  const tickCopy = (await loadRun(dir, 'personal', run.run_id))!
  const applied = applyEvents([tickCopy], exitEvents, 'personal', new Set())

  const result = await saveEventedRuns([tickCopy], applied.wake, eventSaveDeps())

  expect(result.runs[0]).toBe(tickCopy)
  expect(result.wake).toEqual(applied.wake)
  expect((await loadRun(dir, 'personal', run.run_id))?.tasks[0]?.phase).toBe('failed')
})

test('a run that cannot be saved even after a re-read sits out the rest of the tick', async () => {
  const run = mkRun([mkTask({})])
  await saveRun(dir, run)
  const tickCopy = (await loadRun(dir, 'personal', run.run_id))!
  const applied = applyEvents([tickCopy], exitEvents, 'personal', new Set())

  const warnings: string[] = []
  const result = await saveEventedRuns([tickCopy], applied.wake, {
    ...eventSaveDeps(warnings),
    save: async (r) => { throw new StaleRunError(r.run_id) },
  })

  expect(result.runs).toHaveLength(0)
  expect(result.wake).toHaveLength(0)
  expect(warnings).toHaveLength(1)
})

test('the footer agrees with hpipe status on the rows no actor column can see', () => {
  // A files block behind a dead holder and an idle worker sitting on uncommitted
  // work both wait on a person, though neither row's actor says so.
  const now = 1_000_000
  const run = mkRun([])
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'failed', files: ['src/a.ts'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['src/a.ts'], phase_entered_at: now }),
    mkTask({ task_id: 't3', phase: 'implement', phase_entered_at: now,
             uncommitted_work: { at: now, count: 1, sample: ['src/b.ts'] } }),
  ]
  expect(parkedFooter(run, new Set(), now, 'hp')).toBe(
    'also waiting on you:\n' +
    '- t2 feat/x (#1) [blocked-on-files 0m] — YOUR move: `hp release --task t1`\n' +
    '- t3 feat/x (#1) [implement 0m] — YOUR move: worker idle with 1 uncommitted path ' +
    '(src/b.ts) — have it commit and push',
  )
})

test('an unstarted worker is YOUR move in the digest, not the worker\'s — #12', () => {
  const now = 10_000_000
  const run = mkRun([])
  const unstarted = mkTask({ phase: 'research', pane_id: null, workspace_id: 'w23', adopted_at: 0 })
  run.tasks = [unstarted]
  const clause = actionFor(run, unstarted, 'hp', now)
  expect(clause).toStartWith('YOUR move: no agent detected in its worktree')
  expect(clause).toContain('`hp dispatch --task t1 --pane <pane>`')

  const booting = mkTask({ phase: 'research', pane_id: null, workspace_id: 'w23', adopted_at: now })
  expect(actionFor(run, booting, 'hp', now)).toBe("worker's move: waiting for its research artifact")
})

test('the footer lists an unstarted worker a quiet digest would otherwise hide — #12', () => {
  const now = 10_000_000
  const run = mkRun([mkTask({
    phase: 'research', pane_id: null, workspace_id: 'w23', adopted_at: 0, phase_entered_at: 0,
  })])
  const footer = parkedFooter(run, new Set(), now, 'hp')
  expect(footer).toContain('also waiting on you:')
  expect(footer).toContain('t1 feat/x (#1) [research 166m] — YOUR move: no agent detected in its worktree')
})

test('binding a worker pane re-arms the stall ladder, and a repeat bind does not — #12', () => {
  const run = mkRun([mkTask({ phase: 'research', pane_id: null, phase_entered_at: 5 })])
  const task = run.tasks[0]!
  task.stall = { at: 5, run_at: run.phase_entered_at, last_probe_at: 6, probes: 3, undelivered: 1, holds: 0 }
  const detected: QueuedEvent = {
    kind: 'pane.agent_detected', session: 'personal', at: 1, pane_id: 'w7:p2', workspace_id: 'w7',
  }

  applyEvents([run], [detected], 'personal', new Set())
  expect(task.pane_id).toBe('w7:p2')
  expect(task.stall?.probes).toBe(0)
  expect(task.stall?.undelivered).toBe(0)
  const rearmedAt = task.stall?.last_probe_at

  task.stall!.probes = 1
  applyEvents([run], [detected], 'personal', new Set())
  expect(task.stall?.probes).toBe(1)
  expect(task.stall?.last_probe_at).toBe(rearmedAt!)
})

test('a dead pane is unbound, so a rewind out of failed reads as unstarted, not bound — #12', () => {
  for (const event of [
    { kind: 'pane.exited', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7' },
    { kind: 'pane.agent_detected', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', released: true },
  ] as QueuedEvent[]) {
    const run = mkRun([mkTask({ phase: 'implement', adopted_at: 0 })])
    const task = run.tasks[0]!
    applyEvents([run], [event], 'personal', new Set())
    expect(task.phase).toBe('failed')
    expect(task.pane_id).toBeNull()
    expect(task.workspace_id).toBe('w7')

    task.phase = 'implement'
    expect(overdueUnstartedWorker(run, task, UNSTARTED_GRACE_MS)).not.toBeNull()
  }
})

test('a new pane on a row the orchestrator owns does not re-arm its ladder — #12', () => {
  const run = mkRun([mkTask({ phase: 'merge', pane_id: 'w7:p1', phase_entered_at: 5 })])
  const task = run.tasks[0]!
  task.stall = { at: 5, run_at: run.phase_entered_at, last_probe_at: 6, probes: 2, undelivered: 0, holds: 0 }
  applyEvents([run], [{
    kind: 'pane.agent_detected', session: 'personal', at: 1, pane_id: 'w7:p2', workspace_id: 'w7',
  }], 'personal', new Set())
  expect(task.pane_id).toBe('w7:p2')
  expect(task.stall?.probes).toBe(2)
})

test('a dead pane stays nameable after it is unbound — #12', () => {
  const run = mkRun([mkTask({ phase: 'implement' })])
  applyEvents([run], [{
    kind: 'pane.exited', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7',
  }], 'personal', new Set())
  expect(run.tasks[0]!.last_pane_id).toBe('w7:p1')
})

test('a run asking after a slow send gets a fresh idle reading, not the one from the tick\'s start', async () => {
  const clock = { now: 0 }
  let builds = 0
  const idle = refreshingIdleReader(() => {
    builds += 1
    const idleAtBuild = builds === 1
    return async () => idleAtBuild
  }, () => clock.now, 2000)

  expect(await idle('w1:p1')).toBe(true)
  clock.now = 1500
  expect(await idle('w1:p1')).toBe(true)
  expect(builds).toBe(1)

  clock.now = 7000
  expect(await idle('w1:p1')).toBe(false)
  expect(builds).toBe(2)
})
