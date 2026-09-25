import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyStalls, bumpStall, ladderFor, stallAwaiting, stallCandidates, stallStateFor,
  type StallDeps, taskStallCandidates, undeliveredNote,
} from '../src/supervisor/stall'
import { listRuns, newRun, saveOrReapply, saveRun } from '../src/lib/ledger'
import { TASK_ROWS } from '../src/lib/phases'
import { actionFor } from '../src/lib/status'
import { bindWorkerPane } from '../src/lib/unstarted'
import { rollUpBucket } from '../src/lib/gh'
import { enqueue } from '../src/lib/outbox'
import type { Run, RunPhase, Task } from '../src/lib/types'

const ORCHESTRATOR_PANE = 'w1:p1'

function runAt(phase: RunPhase, enteredAt: number): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = phase
  run.phase_entered_at = enteredAt
  run.orchestrator_pane = ORCHESTRATOR_PANE
  return run
}

const NOW = 1_000_000
// Past both the run-level (15 min) and task-level (45 min) thresholds under test.
const LONG_AGO = NOW - 60 * 60 * 1000

test('a verdict phase open past the threshold is a candidate', () => {
  expect(stallCandidates([runAt('branch-review', LONG_AGO)], NOW, 15, 3)).toHaveLength(1)
})

test('execute is probed once every task is terminal but intake was never closed', () => {
  const run = runAt('execute', LONG_AGO)
  run.intake_closed = false
  run.tasks = [mkTask({ phase: 'done' })]
  const out = stallCandidates([run], NOW, 15, 3)
  expect(out.map((c) => c.paneId)).toEqual([ORCHESTRATOR_PANE])
})

test('a healthy execute with work still running is NOT probed', () => {
  // v4's third review round removed exactly this false alarm: a six-worker run
  // would otherwise be probed 15 minutes in, while the orchestrator is busiest.
  const run = runAt('execute', LONG_AGO)
  run.intake_closed = false
  run.tasks = [mkTask({ phase: 'implement' }), mkTask({ task_id: 't2', phase: 'done' })]
  expect(stallCandidates([run], NOW, 15, 3)).toHaveLength(0)
})

test('execute is not probed once intake is properly closed', () => {
  const run = runAt('execute', LONG_AGO)
  run.intake_closed = true
  run.tasks = [mkTask({ phase: 'done' })]
  expect(stallCandidates([run], NOW, 15, 3)).toHaveLength(0)
})

test('dispatch is probed via the orchestrator too — its row is stallable', () => {
  const run = runAt('dispatch', LONG_AGO)
  expect(stallCandidates([run], NOW, 15, 3).map((c) => c.paneId))
    .toEqual([ORCHESTRATOR_PANE])
})

test('a run phase whose row is not stallable is never a candidate', () => {
  for (const phase of ['intake', 'escalated', 'done'] as const) {
    expect(stallCandidates([runAt(phase, LONG_AGO)], NOW, 15, 3)).toHaveLength(0)
  }
})

test('a phase within the threshold is not a candidate', () => {
  expect(stallCandidates([runAt('branch-review', NOW - 60_000)], NOW, 15, 3)).toHaveLength(0)
})

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
  phase: 'implement', phase_entered_at: LONG_AGO, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: '/r/.worktrees/feat-x', registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

function runWithTasks(tasks: Task[]): Run {
  const run = runAt('execute', LONG_AGO)
  run.tasks = tasks
  return run
}

const runWithTask = (over: Partial<Task>): Run =>
  runWithTasks([mkTask({ phase_entered_at: LONG_AGO, ...over })])

test('a task sitting in implement past the threshold with no PR is a candidate', () => {
  const run = runWithTasks([mkTask({})])
  expect(taskStallCandidates([run], NOW, 45, 3)).toHaveLength(1)
})

test('a task that re-entered implement with an open PR is still probed', () => {
  // Re-entry from a blocker review or red CI: the PR exists and head_sha_at_entry
  // is the rejected sha, so a silent worker would otherwise never be noticed.
  const run = runWithTasks([mkTask({ pr: 42, head_sha_at_entry: 'rejected' })])
  expect(taskStallCandidates([run], NOW, 45, 3)).toHaveLength(1)
})

test('a task inside the threshold is not a candidate', () => {
  const run = runWithTasks([mkTask({ phase_entered_at: NOW - 60_000 })])
  expect(taskStallCandidates([run], NOW, 45, 3)).toHaveLength(0)
})

test('a task phase whose row is not stallable is never probed', () => {
  for (const phase of ['queued', 'done', 'failed', 'orphaned', 'blocked-on-failure'] as const) {
    const run = runWithTasks([mkTask({ phase })])
    expect(taskStallCandidates([run], NOW, 45, 3)).toHaveLength(0)
  }
})

test('a task stranded in blocked-on-files is probed via the orchestrator', () => {
  const run = runWithTask({ phase: 'blocked-on-files', pane_id: null })
  const out = taskStallCandidates([run], NOW, 15, 3)
  expect(out).toHaveLength(1)
  expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
})

test('a task waiting in blocked-on-decision is probed via the orchestrator', () => {
  const run = runWithTask({ phase: 'blocked-on-decision', pane_id: 'w7:p1' })
  const out = taskStallCandidates([run], NOW, 15, 3)
  expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
})

test('a worker-owned artifact row is probed via the worker pane', () => {
  const run = runWithTask({ phase: 'spec', pane_id: 'w7:p1' })
  const out = taskStallCandidates([run], NOW, 15, 3)
  expect(out[0]?.paneId).toBe('w7:p1')
})

test('a worker row with no pane falls back to the orchestrator', () => {
  const run = runWithTask({ phase: 'research', pane_id: null })
  const out = taskStallCandidates([run], NOW, 15, 3)
  expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
})

test('stall state reads as zero when absent, anchored at the later phase entry', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  expect(stallStateFor(run, task)).toEqual({
    at: 900, run_at: 500, last_probe_at: 900, probes: 0, undelivered: 0, holds: 0,
  })
})

test('the anchor is the LATER of the two entries — a run phase change re-arms the task', () => {
  const run = runAt('branch-review', 9000)
  const task = mkTask({ phase_entered_at: 900 })
  expect(stallStateFor(run, task).last_probe_at).toBe(9000)
})

test('a stall state whose record stamp is stale reads as zero', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  task.stall = { at: 111, run_at: 500, last_probe_at: 111, probes: 3, holds: 0 }
  expect(stallStateFor(run, task).probes).toBe(0)
})

test('a stall state whose RUN stamp is stale reads as zero', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  task.stall = { at: 900, run_at: 222, last_probe_at: 900, probes: 3, holds: 0 }
  expect(stallStateFor(run, task).probes).toBe(0)
})

test('a stall state with both stamps matching is returned as stored', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  task.stall = { at: 900, run_at: 500, last_probe_at: 1234, probes: 2, holds: 1 }
  expect(stallStateFor(run, task)).toEqual(task.stall)
})

test('a bump rewrites both stamps, or the next read would reject it', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  bumpStall(run, task, 'probes', 5000)
  expect(task.stall).toEqual({
    at: 900, run_at: 500, last_probe_at: 5000, probes: 1, undelivered: 0, holds: 0,
  })
  expect(stallStateFor(run, task).probes).toBe(1)
})

test('bumps accumulate, and holds and probes count separately', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  bumpStall(run, task, 'probes', 1000)
  bumpStall(run, task, 'probes', 2000)
  bumpStall(run, task, 'holds', 3000)
  expect(stallStateFor(run, task)).toEqual({
    at: 900, run_at: 500, last_probe_at: 3000, probes: 2, undelivered: 0, holds: 1,
  })
})

test('a bump on a stale state replaces it rather than incrementing it', () => {
  const run = runAt('branch-review', 500)
  const task = mkTask({ phase_entered_at: 900 })
  task.stall = { at: 111, run_at: 500, last_probe_at: 111, probes: 7, holds: 7 }
  bumpStall(run, task, 'probes', 4000)
  expect(stallStateFor(run, task).probes).toBe(1)
  expect(stallStateFor(run, task).holds).toBe(0)
})

test('an artifact row names a real absolute path and says how to fix a misfile', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'research', checkout_path: '/wt' })
  task.artifacts.research = 'docs/superpowers/research/r.md'
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp')
  expect(a.clause).toContain('/wt/docs/superpowers/research/r.md')
  expect(a.clause).toContain('Nothing has appeared at')
  expect(a.short).toBe('its research artifact')
})

test('the artifact clause does not reassert the sentence #9 retired from the brief', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'research', checkout_path: '/wt' })
  task.artifacts.research = 'docs/superpowers/research/r.md'
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp')
  expect(a.clause).not.toContain('stats that path and nothing else')
  expect(a.clause).toContain("does not satisfy this phase's contract")
})

test('a task with no worktree is told it was never dispatched, not sent at the main checkout', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'research', checkout_path: null })
  task.artifacts.research = 'docs/superpowers/research/r.md'
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp')
  // `/r` is the run repo_root in these fixtures; naming it would point the reader
  // at the orchestrator's own tree.
  expect(a.clause).not.toContain('/r/docs/superpowers/research/r.md')
  expect(a.short).toContain('never been dispatched')
})

test('an artifact that exists but is stale is not described as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-awaiting-'))
  mkdirSync(join(dir, 'docs/superpowers/research'), { recursive: true })
  writeFileSync(join(dir, 'docs/superpowers/research/r.md'), 'stale pass output')
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'research', checkout_path: dir })
  task.artifacts.research = 'docs/superpowers/research/r.md'
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp', NOW)
  expect(a.clause).not.toContain('Nothing has appeared at')
  expect(a.clause).toContain("Nothing newer than this phase's start")
  rmSync(dir, { recursive: true, force: true })
})

test('a verdict row shares the path branch but not the short form', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'spec-review', checkout_path: '/wt' })
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp')
  expect(a.short).toBe('its review verdict')
  expect(a.clause).toContain('/wt/docs/superpowers/reviews/')
})

test('a run verdict row resolves against the repo root, not a worktree', () => {
  const run = runAt('branch-review', LONG_AGO)
  const a = stallAwaiting(run, null, 'hp')
  expect(a.short).toBe('its review verdict')
  expect(a.clause).toContain('/r/docs/superpowers/reviews/')
})

test('a pr row names the PR, never a path — the defect the issue addendum raised', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', branch: 'fix/x', issue: 38 })
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp')
  expect(a.clause).toBe('This phase is waiting for a pushed PR for fix/x (#38).')
  expect(a.clause).not.toContain('appeared at')
  expect(a.clause).not.toContain('path above')
})

test('run dispatch waits on a worktree, and never names a reviews path', () => {
  const a = stallAwaiting(runAt('dispatch', LONG_AGO), null, 'hp')
  expect(a.clause).toBe(
    'This phase is waiting for a worktree to be adopted for a dispatched task.')
  expect(a.clause).not.toContain('docs/superpowers/reviews')
})

test('run execute names the rendered hpipe command, never a raw placeholder', () => {
  const a = stallAwaiting(runAt('execute', LONG_AGO), null, 'bun run /p/src/cli.ts')
  expect(a.clause).toBe(
    'This phase is waiting for `bun run /p/src/cli.ts dispatch --done` to close intake.')
  expect(a.clause).not.toContain('{{')
})

test('the blocked rows name the exit, not the symptom', () => {
  const run = runAt('execute', LONG_AGO)
  const files = mkTask({ phase: 'blocked-on-files' })
  const decision = mkTask({ task_id: 't2', phase: 'blocked-on-decision' })
  const teardown = mkTask({ task_id: 't3', phase: 'teardown' })
  run.tasks = [files, decision, teardown]
  expect(stallAwaiting(run, files, 'hp')).toEqual({
    short: 'the files another task holds',
    clause: 'This phase is waiting for another task to release the files this one declared.',
  })
  expect(stallAwaiting(run, decision, 'hp').short).toBe('an answer to the open decision')
  expect(stallAwaiting(run, teardown, 'hp').short).toBe('its worktree to be removed')
})

test('an unbriefed agent is probed through the orchestrator, with the dispatch advice — #89', () => {
  const run = runWithTask({ phase: 'research', awaiting_brief: true, agent_status: 'idle' })
  const [c] = taskStallCandidates([run], NOW, 45, 3)
  expect(c?.paneId).toBe(ORCHESTRATOR_PANE)
  expect(c?.actorPaneId).toBe(ORCHESTRATOR_PANE)
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp', NOW)
  expect(a.clause).toContain('never handed the brief')
  expect(a.clause).toContain('`hp dispatch --task t1 --pane w7:p1`')
  expect(a.clause).not.toContain('Nothing has appeared')
})

test('an unbriefed agent is probed on the orchestrator\'s cadence, not the worker\'s — #89', () => {
  const run = runWithTask({ phase: 'research', awaiting_brief: true, phase_entered_at: NOW - 20 * 60_000 })
  expect(taskStallCandidates([run], NOW, 45, 3, 15)).toHaveLength(1)
  delete run.tasks[0]!.awaiting_brief
  expect(taskStallCandidates([run], NOW, 45, 3, 15)).toHaveLength(0)
})

test('a move clause names what the stall probe for the same row names — #95', () => {
  for (const row of TASK_ROWS) {
    if (row.actor !== 'orchestrator' && row.actor !== 'worker') continue
    for (const pr of [null, 7]) {
      const task = mkTask({
        phase: row.phase, pr,
        artifacts: { research: 'r.md', spec: 's.md', plan: 'p.md', verdicts: {} },
      })
      const run = runWithTasks([task])
      expect(actionFor(run, task, 'hp', NOW), row.phase)
        .toEndWith(`waiting for ${stallAwaiting(run, task, 'hp', NOW).short}`)
    }
  }
})

test('an unrecognised signal falls back to naming the phase', () => {
  // Characterisation, not behaviour: after #19 every TASK_ROWS signal has a
  // branch, so the only row that can reach the fallback is a run row with
  // `signal: 'registration'` — and no such row is stallable. Same status as
  // `describeWake`'s null-task arm (tick.ts:59-64).
  expect(stallAwaiting(runAt('intake', LONG_AGO), null, 'hp')).toEqual({
    short: 'whatever clears intake',
    clause: 'This phase is waiting for whatever clears intake.',
  })
})

test('an escalating row is told its position and the bound', () => {
  expect(ladderFor({ probes: 1, undelivered: 0, escalatable: true }, 3)).toBe(
    'This is probe 2 of 3. After 3 unanswered probes this phase is escalated to the human ' +
    'and stops moving on its own.')
})

test('an excluded row is never promised a bound it does not have', () => {
  expect(ladderFor({ probes: 8, undelivered: 0, escalatable: false }, 3)).not.toContain('of 3')
  expect(ladderFor({ probes: 8, undelivered: 0, escalatable: false }, 3)).toContain('standing nudge')
})

test('a run with no orchestrator pane produces no candidate at all', () => {
  const run = runAt('branch-review', LONG_AGO)
  run.orchestrator_pane = null
  expect(stallCandidates([run], NOW, 15, 3)).toHaveLength(0)
  run.orchestrator_pane = ORCHESTRATOR_PANE
  expect(stallCandidates([run], NOW, 15, 3)).toHaveLength(1)
})

test('an aged record gets ONE probe, not one per tick — the P4 regression', () => {
  // The pass-1 blocker: a record first observed 13 hours past its threshold was
  // due for every rung at once and climbed one per tick at TICK_MS=1000.
  const entered = NOW - 780 * 60_000
  const run = runAt('execute', entered)
  const task = mkTask({ phase: 'implement', phase_entered_at: entered })
  run.tasks = [task]

  let now = NOW
  let probes = 0
  for (let tick = 0; tick < 4; tick++) {
    const out = taskStallCandidates([run], now, 45, 3)
    if (out.length > 0) {
      expect(out[0]?.action).toBe('probe')
      bumpStall(run, task, 'probes', now)
      probes += 1
    }
    now += 1000
  }
  expect(probes).toBe(1)
})

test('the next rung is due a threshold after the LAST probe, not after phase entry', () => {
  const entered = NOW - 780 * 60_000
  const run = runAt('execute', entered)
  const task = mkTask({ phase: 'implement', phase_entered_at: entered })
  run.tasks = [task]
  bumpStall(run, task, 'probes', NOW)

  expect(taskStallCandidates([run], NOW + 44 * 60_000, 45, 3)).toHaveLength(0)
  expect(taskStallCandidates([run], NOW + 45 * 60_000, 45, 3)).toHaveLength(1)
})

test('escalation only at the cap, and only for actor-produced signals (A18)', () => {
  const run = runAt('execute', LONG_AGO)
  const impl = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  const decision = mkTask({
    task_id: 't2', phase: 'blocked-on-decision', phase_entered_at: LONG_AGO,
  })
  run.tasks = [impl, decision]
  impl.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }
  decision.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 9, holds: 0,
  }

  const out = taskStallCandidates([run], NOW, 45, 3)
  expect(out.find((c) => c.task?.task_id === 't1')?.action).toBe('escalate')
  expect(out.find((c) => c.task?.task_id === 't2')?.action).toBe('probe')
  expect(out.find((c) => c.task?.task_id === 't2')?.escalatable).toBe(false)
})

test('one below the cap is still a probe', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 2, holds: 0,
  }
  expect(taskStallCandidates([run], NOW, 45, 3)[0]?.action).toBe('probe')
})

test('tasks inside an aborted or escalated run are left alone (A26)', () => {
  // cmdAbort sets run.phase = 'done' and deliberately leaves tasks live
  // (src/cli.ts:292-302). Without this guard the ladder probes them forever
  // and escalates them, breaking the documented abort/resume contract.
  for (const phase of ['done', 'escalated'] as const) {
    const run = runAt(phase, LONG_AGO)
    run.tasks = [mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })]
    expect(taskStallCandidates([run], NOW, 45, 3)).toHaveLength(0)
  }
})

test('the run level needs no such guard — neither row is stallable', () => {
  for (const phase of ['done', 'escalated'] as const) {
    expect(stallCandidates([runAt(phase, LONG_AGO)], NOW, 15, 3)).toHaveLength(0)
  }
})

test('hpipe resume re-arms a task ladder without cmdResume touching tasks (A30)', () => {
  const entered = NOW - 800 * 60_000
  const run = runAt('execute', entered)
  const task = mkTask({ phase: 'implement', phase_entered_at: entered })
  run.tasks = [task]
  task.stall = {
    at: entered, run_at: entered, last_probe_at: NOW - 780 * 60_000, probes: 3, holds: 0,
  }
  expect(taskStallCandidates([run], NOW, 45, 3)[0]?.action).toBe('escalate')

  // cmdResume's exact mutation (src/cli.ts:315-317): run only, tasks untouched.
  run.phase = 'execute'
  run.phase_entered_at = NOW
  expect(task.stall!.at).toBe(entered)

  expect(taskStallCandidates([run], NOW, 45, 3)).toHaveLength(0)
  expect(taskStallCandidates([run], NOW + 45 * 60_000, 45, 3)[0]?.action).toBe('probe')
})

test('the escalation gate is the row actor pane, not the probe pane (A7)', () => {
  const run = runAt('execute', LONG_AGO)
  const worker = mkTask({ phase: 'implement', pane_id: 'w7:p1', phase_entered_at: LONG_AGO })
  const paneless = mkTask({
    task_id: 't2', phase: 'research', pane_id: null, phase_entered_at: LONG_AGO,
  })
  run.tasks = [worker, paneless]
  const out = taskStallCandidates([run], NOW, 45, 3)
  expect(out.find((c) => c.task?.task_id === 't1')?.actorPaneId).toBe('w7:p1')
  expect(out.find((c) => c.task?.task_id === 't2')?.paneId).toBe(ORCHESTRATOR_PANE)
  expect(out.find((c) => c.task?.task_id === 't2')?.actorPaneId).toBeNull()
})

type TestDeps = StallDeps & { sent: string[] }

// Annotated, not cast: `as` would defeat contextual typing and let
// `agentStatus` widen from AgentStatus to string.
const mkDeps = (over: Partial<StallDeps> = {}): TestDeps => {
  const sent: string[] = []
  const base: TestDeps = {
    sent,
    probeMax: 3,
    now: () => NOW,
    probe: async (c) => { sent.push(`probe:${c.task?.task_id ?? 'run'}`); return { ok: true } },
    escalationText: async () => 'escalation text',
    queueEscalation: (c) => { sent.push(`escalate:${c.task?.task_id ?? 'run'}`) },
    agentStatus: async () => 'idle',
    persist: async () => {},
  }
  return { ...base, ...over, sent }
}

test('a probe deferred by the supervisor\'s own send budget records nothing — it is no sign of the pane', async () => {
  const run = runWithTask({ phase: 'implement', phase_entered_at: 0 })
  const due = 45 * 60_000
  let persisted = 0
  await applyStalls(taskStallCandidates([run], due, 45, 3), mkDeps({
    now: () => due,
    persist: async () => { persisted += 1 },
    probe: async () => ({ ok: false, deferred: true }),
  }))
  expect(run.tasks[0]?.stall).toBeUndefined()
  expect(persisted).toBe(0)
})

test('a probe that fails once and lands next tick costs no rung — #32', async () => {
  const run = runWithTask({ phase: 'implement', phase_entered_at: 0 })
  const task = run.tasks[0] as Task
  const due = 45 * 60_000
  let persisted = 0
  const persist = async () => { persisted += 1 }

  await applyStalls(taskStallCandidates([run], due, 45, 3),
    mkDeps({ now: () => due, persist, probe: async () => ({ ok: false }) }))
  expect(stallStateFor(run, task).probes).toBe(0)
  expect(stallStateFor(run, task).undeliverable_since).toBe(due)
  expect(persisted).toBe(1)

  const nextTick = due + 1000
  const retried = mkDeps({ now: () => nextTick, persist })
  await applyStalls(taskStallCandidates([run], nextTick, 45, 3), retried)
  expect(retried.sent).toEqual(['probe:t1'])
  expect(stallStateFor(run, task).probes).toBe(1)
  expect(stallStateFor(run, task).undelivered).toBe(0)
  expect(stallStateFor(run, task).undeliverable_since).toBeUndefined()
  expect(stallStateFor(run, task).last_probe_at).toBe(nextTick)
})

/** Ticks once a second until escalation; reports when it happened and what it cost. */
async function escalateAgainst(deliveredAt: (now: number) => boolean) {
  const run = runWithTask({ phase: 'implement', phase_entered_at: 0 })
  const task = run.tasks[0] as Task
  let now = 0
  let attempts = 0
  let persisted = 0
  const deps = mkDeps({
    probe: async () => { attempts += 1; return { ok: deliveredAt(now) } },
    agentStatus: async () => 'unknown',
    persist: async () => { persisted += 1 },
  })
  for (; now <= 300 * 60_000 && task.phase === 'implement'; now += 1000) {
    await applyStalls(taskStallCandidates([run], now, 45, 3), { ...deps, now: () => now })
  }
  return { run, task, attempts, persisted, minute: Math.floor(now / 60_000), sent: deps.sent }
}

test('an unreachable pane escalates at the same minute as a silent one — #32', async () => {
  // The issue's demonstration was 1000 ticks, 1000 sends, no escalation.
  const silent = await escalateAgainst(() => true)
  const unreachable = await escalateAgainst(() => false)
  expect(silent.minute).toBe(180)
  expect(unreachable.minute).toBe(silent.minute)
  expect(unreachable.task.phase).toBe('escalated')
  expect(unreachable.sent).toEqual(['escalate:t1'])
  expect(unreachable.run.history.at(-1)?.why)
    .toBe('3 stall probes unanswered, 3 of them undelivered')
})

test('a pane that goes unreachable after a delivered probe escalates on the silent cadence — #32', async () => {
  const firstRungDelivered = (now: number) => now < 46 * 60_000
  const { task, run, minute } = await escalateAgainst(firstRungDelivered)
  expect(minute).toBe(180)
  expect(task.phase).toBe('escalated')
  expect(run.history.at(-1)?.why).toBe('3 stall probes unanswered, 2 of them undelivered')
})

test('an unreachable pane is retried once a tick but written to the ledger once a rung — #32', async () => {
  const { attempts, persisted } = await escalateAgainst(() => false)
  const ticksFromFirstDueToLastRungInclusive = (180 - 45) * 60 + 1
  expect(attempts).toBe(ticksFromFirstDueToLastRungInclusive)
  // The streak start, three climbs, and the escalation itself.
  expect(persisted).toBe(5)
})

test('a stall state written before #32 reads as zero undelivered', async () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 2, holds: 0,
  }
  const failing = { probe: async () => ({ ok: false }) }
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), mkDeps(failing))
  const later = NOW + 45 * 60_000
  await applyStalls(taskStallCandidates([run], later, 45, 3), mkDeps({ ...failing, now: () => later }))
  expect(stallStateFor(run, task).probes).toBe(3)
  expect(stallStateFor(run, task).undelivered).toBe(1)
})

test('the ladder sentence owns up to rungs that never reached the pane — #32', () => {
  expect(ladderFor({ probes: 2, undelivered: 2, escalatable: true }, 3))
    .toContain('2 earlier probes could not be delivered')
  expect(ladderFor({ probes: 2, undelivered: 0, escalatable: true }, 3))
    .not.toContain('could not be delivered')
})

test('the escalation note names an unreachable pane only when a probe went undelivered — #32', () => {
  expect(undeliveredNote(0)).toBe('')
  expect(undeliveredNote(3)).toContain('3 of them never reached')
})

test('a bump survives the ledger round trip that every tick performs', async () => {
  // The fake `persist` above proves applyStalls CALLS it. This proves the state
  // actually survives saveRun/listRuns — without which `last_probe_at` never
  // advances across ticks and the rung-per-tick burst is back. A fake cannot
  // show this: the object re-read above is the same one the bump mutated.
  const dir = mkdtempSync(join(tmpdir(), 'stall-'))
  const run = runAt('execute', LONG_AGO)
  run.tasks = [mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })]
  await applyStalls(
    taskStallCandidates([run], NOW, 45, 3),
    mkDeps({ persist: (r) => saveRun(dir, r) }),
  )

  const [reloaded] = await listRuns(dir, run.session)
  expect(stallStateFor(reloaded!, reloaded!.tasks[0]!).probes).toBe(1)
  expect(taskStallCandidates([reloaded!], NOW, 45, 3)).toHaveLength(0)
})

test('a working actor is deferred, counting holds and not probes', async () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }

  const deps = mkDeps({ agentStatus: async () => 'working' })
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), deps)
  expect(deps.sent).toEqual([])
  expect(stallStateFor(run, task).holds).toBe(1)
  expect(stallStateFor(run, task).probes).toBe(3)
  // A20: a deferral moves the anchor, so the actor is re-consulted once per
  // threshold rather than once per tick.
  expect(stallStateFor(run, task).last_probe_at).toBe(NOW)
})

test('deferrals are bounded — past the cap it escalates anyway (A27)', async () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 3,
  }

  const deps = mkDeps({ agentStatus: async () => 'working' })
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), deps)
  expect(deps.sent).toEqual(['escalate:t1'])
})

test('only `working` defers — blocked and unknown escalate', async () => {
  for (const status of ['idle', 'done', 'blocked', 'unknown'] as const) {
    const run = runAt('execute', LONG_AGO)
    const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
    run.tasks = [task]
    task.stall = {
      at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
    }
    const deps = mkDeps({ agentStatus: async () => status })
    await applyStalls(taskStallCandidates([run], NOW, 45, 3), deps)
    expect(deps.sent, `${status} must escalate`).toEqual(['escalate:t1'])
  }
})

test('a paneless worker escalates without consulting anyone (A7, through applyStalls)', async () => {
  // The candidate-level test pins actorPaneId === null. This drives it through
  // applyStalls: the deferral gate must be skipped entirely rather than asking
  // the orchestrator — probePaneFor's fallback pane — how the worker is doing.
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'research', pane_id: null, phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }

  let statusCalls = 0
  const deps = mkDeps({
    agentStatus: async () => { statusCalls += 1; return 'working' },
  })
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), deps)

  expect(deps.sent).toEqual(['escalate:t1'])
  expect(statusCalls).toBe(0)
  expect(stallStateFor(run, task).holds).toBe(0)
})

test('applyStalls performs the transition itself — task branch', async () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), mkDeps())

  expect(task.phase).toBe('escalated')
  expect(task.escalated_from).toBe('implement')
  expect(run.history.at(-1)?.why).toBe('3 stall probes unanswered')
})

test('applyStalls performs the transition itself — run branch', async () => {
  // The run branch had no coverage: with the transition injected, replacing it
  // with an unconditional enterRunPhase left the whole suite green.
  const run = runAt('branch-review', LONG_AGO)
  run.stall = {
    at: run.phase_entered_at, run_at: run.phase_entered_at,
    last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }
  await applyStalls(stallCandidates([run], NOW, 15, 3), mkDeps())

  expect(run.phase).toBe('escalated')
  expect(run.escalated_from).toBe('branch-review')
  expect(run.history.at(-1)?.why).toBe('3 stall probes unanswered')
})

test('the escalation text is rendered BEFORE the transition overwrites the phase', async () => {
  // Ordering hazard: `escalated`'s row has signal 'manual', so a description
  // taken after the transition describes the wrong thing entirely.
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }

  const seen: string[] = []
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), mkDeps({
    escalationText: async (c, from) => { seen.push(`${from}|${c.task?.phase}`); return 'x' },
  }))
  expect(seen).toEqual(['implement|implement'])
})

test('the escalation prompt is queued after the transition, and one save carries both', async () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }

  const order: string[] = []
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), mkDeps({
    persist: async (r) => { order.push(`persist:${r.tasks[0]?.phase}`) },
    queueEscalation: (c) => { order.push(`queue:${c.task?.phase}`) },
  }))
  expect(order).toEqual(['queue:escalated', 'persist:escalated'])
})

test('a sent probe whose save lost to a CLI write is still counted', async () => {
  // Otherwise the next tick probes again at once instead of waiting a rung.
  const dir = mkdtempSync(join(tmpdir(), 'stall-'))
  const run = runAt('execute', LONG_AGO)
  run.tasks = [mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })]
  await saveRun(dir, run)
  const [tickCopy] = await listRuns(dir, run.session)
  const [cliCopy] = await listRuns(dir, run.session)
  cliCopy!.intake_closed = true
  await saveRun(dir, cliCopy!)

  const deps = mkDeps({ persist: (r, effect) => saveOrReapply(dir, r, effect ? [effect] : []) })
  await applyStalls(taskStallCandidates([tickCopy!], NOW, 45, 3), deps)

  const [reloaded] = await listRuns(dir, run.session)
  expect(deps.sent).toEqual(['probe:t1'])
  expect(reloaded?.intake_closed).toBe(true)
  expect(stallStateFor(reloaded!, reloaded!.tasks[0]!).probes).toBe(1)
  rmSync(dir, { recursive: true, force: true })
})

test('an undelivered-streak start whose save lost to a CLI write is still recorded', async () => {
  // Otherwise every lost save restarts the streak and postpones #61's escalation.
  const dir = mkdtempSync(join(tmpdir(), 'stall-'))
  const run = runWithTask({ phase: 'implement', phase_entered_at: 0 })
  await saveRun(dir, run)
  const [tickCopy] = await listRuns(dir, run.session)
  const [cliCopy] = await listRuns(dir, run.session)
  cliCopy!.intake_closed = true
  await saveRun(dir, cliCopy!)

  const due = 45 * 60_000
  await applyStalls(taskStallCandidates([tickCopy!], due, 45, 3), mkDeps({
    now: () => due,
    probe: async () => ({ ok: false }),
    persist: (r, effect) => saveOrReapply(dir, r, effect ? [effect] : []),
  }))

  const [reloaded] = await listRuns(dir, run.session)
  expect(reloaded?.intake_closed).toBe(true)
  expect(stallStateFor(reloaded!, reloaded!.tasks[0]!).undeliverable_since).toBe(due)
  rmSync(dir, { recursive: true, force: true })
})

test('an escalation whose save lost to a CLI write is not sent, and the batch goes on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-'))
  const stale = runAt('execute', LONG_AGO)
  const stuck = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  stale.tasks = [stuck]
  stuck.stall = {
    at: LONG_AGO, run_at: stale.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }
  await saveRun(dir, stale)
  const [cliCopy] = await listRuns(dir, stale.session)
  cliCopy!.intake_closed = true
  await saveRun(dir, cliCopy!)

  const other = runAt('execute', LONG_AGO)
  other.run_id = 'other'
  other.tasks = [mkTask({ task_id: 't9', phase: 'implement', phase_entered_at: LONG_AGO })]

  const deps = mkDeps({
    queueEscalation: (c, text) => { enqueue(c.run, { to: 'orchestrator', taskId: 't1', text }, NOW) },
    persist: (r, effect) => (r === stale ? saveOrReapply(dir, r, effect ? [effect] : []) : Promise.resolve()),
  })
  await applyStalls(taskStallCandidates([stale, other], NOW, 45, 3), deps)

  const [reloaded] = await listRuns(dir, stale.session)
  expect(reloaded?.tasks[0]?.phase).toBe('implement')
  expect(reloaded?.outbox).toBeUndefined()
  expect(deps.sent).toEqual(['probe:t9'])
  rmSync(dir, { recursive: true, force: true })
})

test('every last-mile row is probed via the orchestrator — #19', () => {
  for (const phase of ['ci', 'merge', 'close', 'teardown', 'escalated'] as const) {
    const run = runWithTask({ phase })
    const out = taskStallCandidates([run], NOW, 45, 3)
    expect(out, `${phase} produced no candidate`).toHaveLength(1)
    expect(out[0]?.paneId, `${phase} is not probed via the orchestrator`).toBe(ORCHESTRATOR_PANE)
    expect(out[0]?.escalatable, `${phase} must not be escalatable`).toBe(false)
  }
})

test('no last-mile row escalates, however many probes go unanswered — #19', async () => {
  for (const phase of ['ci', 'merge', 'close', 'teardown', 'escalated'] as const) {
    const run = runWithTask({ phase })
    const task = run.tasks[0] as Task
    const deps = mkDeps({
      queueEscalation: () => { throw new Error(`${phase} must never escalate`) },
    })
    let now = NOW
    for (let i = 0; i < 20; i += 1) {
      await applyStalls(taskStallCandidates([run], now, 45, 3), { ...deps, now: () => now })
      now += 45 * 60_000
    }
    expect(task.phase, `${phase} left its row`).toBe(phase)
    expect(stallStateFor(run, task).probes, `${phase} stopped probing`).toBeGreaterThan(3)
  }
})

test('a 4h57m merge park produces six probes and no escalation — #19', async () => {
  // t3's real park on the berean-os run of 2026-09-16, replayed minute by minute
  // at the shipped defaults. Measured on a live run.
  const run = runWithTask({ phase: 'merge', phase_entered_at: 0, pr: 42 })
  const task = run.tasks[0] as Task
  let now = 0
  const probesAtMinute: number[] = []
  const deps = mkDeps({
    probe: async () => { probesAtMinute.push(now / 60_000); return { ok: true } },
    queueEscalation: () => { throw new Error('merge must never escalate') },
  })
  for (; now <= (4 * 60 + 57) * 60_000; now += 60_000) {
    await applyStalls(taskStallCandidates([run], now, 45, 3), { ...deps, now: () => now })
  }
  expect(probesAtMinute).toEqual([45, 90, 135, 180, 225, 270])
  expect(task.phase).toBe('merge')
})

test('a last-mile task in a pane-releasing run is left alone — #19 keeps A26', () => {
  for (const runPhase of ['done', 'escalated'] as const) {
    const run = runWithTask({ phase: 'merge' })
    run.phase = runPhase
    expect(taskStallCandidates([run], NOW, 45, 3), runPhase).toHaveLength(0)
  }
})

test('an escalated task is not told it awaits a decision it never asked — #19', () => {
  const run = runWithTask({ phase: 'escalated', escalated_from: 'implement' })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'bun run /p/src/cli.ts')
  expect(a.short).toBe('a human to act on the escalation')
  expect(a.clause).not.toContain('open decision')
  expect(a.clause).not.toContain('an answer to')
  expect(a.clause).toContain('bun run /p/src/cli.ts rewind')
  // The run id is load-bearing: without it the rendered command is `rewind
  // implement --task t1`, which does not run. Nothing else here would catch that.
  expect(a.clause).toContain(run.run_id)
  expect(a.clause).toContain('implement')
  expect(a.clause).toContain('--task t1')
  expect(a.clause).not.toContain('{{')
})

test('an escalated task\'s standing nudge names the abandon as well as the resume', () => {
  const run = runWithTask({ phase: 'escalated', escalated_from: 'implement' })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.clause).toContain(`\`hp rewind ${run.run_id} implement --task t1\` resumes it`)
  expect(a.clause).toContain(`\`hp rewind ${run.run_id} failed --task t1\` abandons it`)
})

test('a run-level escalation offers no task abandon', () => {
  const run = runWithTask({ phase: 'implement' })
  run.phase = 'escalated'
  run.escalated_from = 'branch-review'
  const a = stallAwaiting(run, null, 'hp')
  expect(a.clause).not.toContain('failed')
})

test('blocked-on-decision still names the open decision after the reorder — #19', () => {
  const run = runWithTask({ phase: 'blocked-on-decision' })
  expect(stallAwaiting(run, run.tasks[0] as Task, 'hp').short)
    .toBe('an answer to the open decision')
})

test('a ci row names the check command and not a false forever-wait — #19', () => {
  const run = runWithTask({ phase: 'ci', pr: 42 })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.short).toBe('CI on PR #42')
  expect(a.clause).toContain('gh pr checks 42')
  // rollUpBucket maps `cancel` to `fail` (gh.ts:19), which sends the row back to
  // `implement` — the opposite of waiting forever.
  expect(a.clause).not.toContain('cancelled')
  expect(a.clause).not.toContain('whatever clears')
})

test('a cancelled check rolls up to fail, which is why the ci clause omits it — #19', () => {
  // The clause above asserts `cancelled` is not a forever-wait. That is only true
  // while gh.ts:19 maps it to `fail`; unpinned, the two drift apart in silence —
  // no test in this repo exercised `cancel` before this one.
  expect(rollUpBucket([{ bucket: 'pass' }, { bucket: 'cancel' }])).toBe('fail')
})

test('a row with no PR reports the deadlock and its exit — #19', () => {
  for (const phase of ['ci', 'merge'] as const) {
    const run = runWithTask({ phase, pr: null })
    const a = stallAwaiting(run, run.tasks[0] as Task, 'bun run /p/src/cli.ts')
    expect(a.short, phase).toBe('a PR number this task never recorded')
    expect(a.clause, phase).toContain(
      phase === 'ci' ? 'CI is never polled' : 'no merge is ever seen')
    expect(a.clause, phase).toContain('bun run /p/src/cli.ts rewind')
    // The run id is load-bearing: without it the rendered command is `rewind
    // implement --task t1`, which does not run.
    expect(a.clause, phase).toContain(run.run_id)
    expect(a.clause, phase).toContain('implement --task t1')
    // Must not contradict ladderFor's "clears when whatever it is waiting for
    // arrives" (stall.ts:306-307), which every probe renders beneath the clause.
    expect(a.clause, phase).not.toContain('never clear')
    expect(a.clause, phase).not.toContain('{{')
  }
})

test('a merge row names the PR and does not assert it is unmerged — #19', () => {
  const run = runWithTask({ phase: 'merge', pr: 42 })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.short).toBe('PR #42 to be merged')
  expect(a.clause).toContain('PR #42')
  expect(a.clause).toContain('feat/x')
  expect(a.clause).toContain('nothing merges automatically')
  // The row reads only while the orchestrator is idle, so a merged PR can still
  // be sitting here; the clause must not assert it is unmerged.
  expect(a.clause).toContain('If it is already merged, end your turn')
  expect(a.clause).not.toContain('cannot see it')
})


test('a close row names the issue and does not assert it is still open — #19', () => {
  const run = runWithTask({ phase: 'close' })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.short).toBe('issue #1 to close')
  expect(a.clause).toContain('gh issue view 1 --json closed,state')
  expect(a.clause).toContain('closing keyword')
  // A task rewound into `close` from before `merge` has no `merged_at_ms`, so
  // machine.ts:178-181 can never fire however closed the issue is.
  expect(a.clause).toContain('already closed, this phase cannot see it')
  expect(a.clause).toContain(`hp rewind ${run.run_id} merge --task t1`)
  expect(a.clause).not.toContain('never clear')
  expect(a.clause).not.toContain('whatever clears')
})

test('a teardown row states the fact and diagnoses no cause — #19', () => {
  const run = runWithTask({ phase: 'teardown' })
  const a = stallAwaiting(run, run.tasks[0] as Task, 'hp')
  expect(a.short).toBe('its worktree to be removed')
  expect(a.clause).toContain('not being advanced')
  expect(a.clause).toContain('orchestrator pane')
  // pickOneAdvance has three skips (tick.ts:237-248); the third starves a run
  // with nothing throwing, so the clause must not assert a throw.
  expect(a.clause).not.toContain('throwing')
})

test('the escalation text describes the phase being left, not escalated — #19', async () => {
  const run = runWithTask({ phase: 'implement' })
  const task = run.tasks[0] as Task
  const seen: string[] = []
  const deps = mkDeps({
    escalationText: async (c, from) => {
      seen.push(`${from}|${stallAwaiting(c.run, c.task, 'hp').short}`)
      return 'escalation text'
    },
  })
  let now = NOW
  for (let i = 0; i < 5; i += 1) {
    await applyStalls(taskStallCandidates([run], now, 45, 3), { ...deps, now: () => now })
    now += 45 * 60_000
  }
  expect(seen).toEqual(['implement|a pushed PR for feat/x (#1)'])
  expect(task.phase).toBe('escalated')
})

test('a worktree with no agent in it is probed on the orchestrator cadence — #12', () => {
  // The fault is the orchestrator's, and so is the probe: waiting out the 45-minute
  // worker threshold on a pane nobody started is the berean-os `w23:p1` case.
  const entered = NOW - 20 * 60_000
  const unstarted = runWithTask({
    phase: 'research', pane_id: null, phase_entered_at: entered, adopted_at: entered,
  })
  const out = taskStallCandidates([unstarted], NOW, 45, 3, 15)
  expect(out.map((c) => c.paneId)).toEqual([ORCHESTRATOR_PANE])
  expect(out[0]?.thresholdMs).toBe(15 * 60_000)

  const started = runWithTask({ phase: 'research', pane_id: 'w7:p1', phase_entered_at: entered })
  expect(taskStallCandidates([started], NOW, 45, 3, 15)).toHaveLength(0)
})

test('a worker row with no worktree and no pane is told to the orchestrator as its own move — #94', () => {
  // The live t3: `pane.exited` → failed → `rewind … research`, its workspace gone.
  // `forget` leaves `checkout_path`, so the artifact branch named a path in a
  // worktree nobody was working in.
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({
    phase: 'research', workspace_id: null, pane_id: null, last_pane_id: 'w7:p1', checkout_path: '/wt',
  })
  task.artifacts.research = 'docs/superpowers/research/r.md'
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp', NOW)
  expect(a.clause).not.toContain('Nothing has appeared at')
  expect(a.clause).not.toContain('If you finished')
  expect(a.clause).toContain('no worktree and no agent')
  // Its checkout outlived the workspace, so `create` would fail on the existing path.
  expect(a.clause.indexOf('`herdr worktree open --cwd /r --branch feat/x`'))
    .toBeLessThan(a.clause.indexOf('`herdr worktree create --cwd /r --branch feat/x --base main`'))
  expect(a.clause).toContain('worktree_not_found')
  expect(a.clause).toContain('`hp dispatch --task t1 --pane <root pane>`')
  expect(a.short).toContain('worktree')
})

test('a worktreeless task that never had a checkout is told to create one — #94', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'research', workspace_id: null, pane_id: null, checkout_path: null })
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp', NOW)
  expect(a.clause).toContain('`herdr worktree create --cwd /r --branch feat/x --base main`')
  expect(a.clause).not.toContain('worktree open')
})

test('past the briefed phase, a worktreeless task is not offered the dispatch that would refuse it — #94', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', workspace_id: null, pane_id: null })
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp', NOW)
  expect(a.clause).not.toContain('dispatch --task')
  expect(a.clause).toContain('`hp brief --task t1`')
  expect(a.clause).toContain('in implement')
})

test('a rewind-queued phase prompt is the only handoff: the brief is not offered alongside it — #94', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', workspace_id: null, pane_id: null })
  run.tasks = [task]
  enqueue(run, { to: 'worker', taskId: 't1', text: '# Implement' }, NOW)
  const a = stallAwaiting(run, task, 'hp', NOW)
  expect(a.clause).not.toContain('brief --task')
  expect(a.clause).toContain('its brief and implement prompt are already queued')
})

test('a worktreeless worker row is probed on the orchestrator cadence — #94', () => {
  const entered = NOW - 20 * 60_000
  const run = runWithTask({
    phase: 'research', workspace_id: null, pane_id: null, phase_entered_at: entered, adopted_at: null,
  })
  const out = taskStallCandidates([run], NOW, 45, 3, 15)
  expect(out.map((c) => c.paneId)).toEqual([ORCHESTRATOR_PANE])
  expect(out[0]?.thresholdMs).toBe(15 * 60_000)
})

test('a worktree still inside the bootstrap grace keeps the worker threshold — #12', () => {
  const unstarted = runWithTask({
    phase: 'research', pane_id: null, phase_entered_at: NOW - 20 * 60_000, adopted_at: NOW - 60_000,
  })
  expect(taskStallCandidates([unstarted], NOW, 45, 3, 15)).toHaveLength(0)
})

test('an unstarted worker is told it has no agent, not that its artifact is missing — #12', () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({
    phase: 'research', pane_id: null, workspace_id: 'w23', checkout_path: '/wt', adopted_at: LONG_AGO,
  })
  task.artifacts.research = 'docs/superpowers/research/r.md'
  run.tasks = [task]
  const a = stallAwaiting(run, task, 'hp', NOW)
  expect(a.clause).not.toContain('Nothing has appeared at')
  expect(a.clause).toContain('No agent has been detected')
  expect(a.clause).toContain('herdr pane list --workspace w23')
  expect(a.clause).toContain('`hp dispatch --task t1 --pane <pane>`')
  expect(a.short).toContain('agent')
})

test('a worktree still inside the bootstrap grace is not told it has no agent — #12', () => {
  // A task that entered research at registration can come due on the worker
  // threshold a minute after its worktree was made, while the bootstrap runs.
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({
    phase: 'research', pane_id: null, workspace_id: 'w23', checkout_path: '/wt', adopted_at: NOW - 60_000,
  })
  task.artifacts.research = 'docs/superpowers/research/r.md'
  run.tasks = [task]
  expect(stallAwaiting(run, task, 'hp', NOW).clause).not.toContain('No agent has been detected')
})

test('orchestrator probes about an empty worktree do not count toward the worker\'s escalation — #12', () => {
  const entered = NOW - 50 * 60_000
  const run = runWithTask({
    phase: 'research', pane_id: null, phase_entered_at: entered, adopted_at: entered,
  })
  const task = run.tasks[0]!
  task.stall = { at: entered, run_at: run.phase_entered_at, last_probe_at: NOW - 5 * 60_000,
                 probes: 3, undelivered: 0, holds: 0 }

  bindWorkerPane(run, task, 'w7:p1', NOW)

  expect(taskStallCandidates([run], NOW + 44 * 60_000, 45, 3, 15)).toHaveLength(0)
  const due = taskStallCandidates([run], NOW + 45 * 60_000, 45, 3, 15)
  expect(due.map((c) => [c.action, c.probes, c.paneId])).toEqual([['probe', 0, 'w7:p1']])
})
