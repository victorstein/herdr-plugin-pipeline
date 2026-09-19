import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyStalls, bumpStall, ladderFor, stallAwaiting, stallCandidates, stallStateFor,
  type StallDeps, taskStallCandidates,
} from '../src/supervisor/stall'
import { listRuns, newRun, saveRun } from '../src/lib/ledger'
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
    at: 900, run_at: 500, last_probe_at: 900, probes: 0, holds: 0,
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
    at: 900, run_at: 500, last_probe_at: 5000, probes: 1, holds: 0,
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
    at: 900, run_at: 500, last_probe_at: 3000, probes: 2, holds: 1,
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
  expect(a.short).toBe('its research/spec/plan artifact')
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
  const a = stallAwaiting(run, task, 'hp')
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
  expect(ladderFor({ probes: 1, escalatable: true }, 3)).toBe(
    'This is probe 2 of 3. After 3 unanswered probes this phase is escalated to the human ' +
    'and stops moving on its own.')
})

test('an excluded row is never promised a bound it does not have', () => {
  expect(ladderFor({ probes: 8, escalatable: false }, 3)).not.toContain('of 3')
  expect(ladderFor({ probes: 8, escalatable: false }, 3)).toContain('standing nudge')
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
    sendEscalation: async (c) => { sent.push(`escalate:${c.task?.task_id ?? 'run'}`) },
    agentStatus: async () => 'idle',
    persist: async () => {},
  }
  return { ...base, ...over, sent }
}

test('an accepted probe bumps and persists; a rejected one does neither', async () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]

  let persisted = 0
  const bad = mkDeps({ probe: async () => ({ ok: false }), persist: async () => { persisted += 1 } })
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), bad)
  expect(stallStateFor(run, task).probes).toBe(0)
  expect(persisted).toBe(0)

  const good = mkDeps({ persist: async () => { persisted += 1 } })
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), good)
  expect(stallStateFor(run, task).probes).toBe(1)
  expect(persisted).toBe(1)
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

test('the ledger is persisted before the escalation is sent', async () => {
  const run = runAt('execute', LONG_AGO)
  const task = mkTask({ phase: 'implement', phase_entered_at: LONG_AGO })
  run.tasks = [task]
  task.stall = {
    at: LONG_AGO, run_at: run.phase_entered_at, last_probe_at: LONG_AGO, probes: 3, holds: 0,
  }

  const order: string[] = []
  await applyStalls(taskStallCandidates([run], NOW, 45, 3), mkDeps({
    persist: async (r) => { order.push(`persist:${r.tasks[0]?.phase}`) },
    sendEscalation: async () => { order.push('send') },
  }))
  expect(order).toEqual(['persist:escalated', 'send'])
})

test('every last-mile row is probed via the orchestrator — #19', () => {
  for (const phase of ['ci', 'merge', 'close', 'teardown', 'escalated'] as const) {
    const run = runWithTask({ phase })
    const out = taskStallCandidates([run], NOW, 45, 3)
    expect(out, `${phase} produced no candidate`).toHaveLength(1)
    expect(out[0]?.paneId).toBe(ORCHESTRATOR_PANE)
    expect(out[0]?.escalatable, `${phase} must not be escalatable`).toBe(false)
  }
})

test('no last-mile row escalates, however many probes go unanswered — #19', async () => {
  for (const phase of ['ci', 'merge', 'close', 'teardown', 'escalated'] as const) {
    const run = runWithTask({ phase })
    const task = run.tasks[0] as Task
    const deps = mkDeps({
      sendEscalation: async () => { throw new Error(`${phase} must never escalate`) },
    })
    let now = NOW
    for (let i = 0; i < 20; i += 1) {
      await applyStalls(taskStallCandidates([run], now, 45, 3), { ...deps, now: () => now })
      now += 45 * 60_000
    }
    expect(task.phase, `${phase} left its row`).toBe(phase)
    expect(stallStateFor(run, task).probes).toBeGreaterThan(3)
  }
})

test('a 4h57m merge park produces six probes and no escalation — #19', async () => {
  // t3's real park on the berean-os run of 2026-09-16, replayed minute by minute
  // at the shipped defaults. Measured on a live run.
  const run = runWithTask({ phase: 'merge', phase_entered_at: 0, pr: 42 })
  run.phase_entered_at = 0
  const task = run.tasks[0] as Task
  let now = 0
  const probesAtMinute: number[] = []
  const deps = mkDeps({
    probe: async () => { probesAtMinute.push(now / 60_000); return { ok: true } },
    sendEscalation: async () => { throw new Error('merge must never escalate') },
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
  expect(a.clause).toContain('implement')
  expect(a.clause).toContain('--task t1')
  expect(a.clause).not.toContain('{{')
})

test('blocked-on-decision still names the open decision after the reorder — #19', () => {
  const run = runWithTask({ phase: 'blocked-on-decision' })
  expect(stallAwaiting(run, run.tasks[0] as Task, 'hp').short)
    .toBe('an answer to the open decision')
})
