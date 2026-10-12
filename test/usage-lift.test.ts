import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { newRun, type RunEffect, type SaveOutcome, StaleRunError } from '../src/lib/ledger'
import { enqueue } from '../src/lib/outbox'
import type { AgentStatus, Run, Task, TaskPhase } from '../src/lib/types'
import type { LimitLine } from '../src/lib/usage-limit'
import { type Lift, liftEffect, type LiftTexts, liftLimits } from '../src/supervisor/usage-lift'
import { LIFT_GRACE_MS, UsageLimits } from '../src/supervisor/usage-limits'
import { beadTaskFields } from './helpers/bead-fields'

const ORCHESTRATOR = 'w1:p1'
const SINCE = Date.parse('2026-10-11T12:34:14Z')
const RESET = Date.parse('2026-10-11T16:20:00Z')
const NOW = RESET + LIFT_GRACE_MS
const NOTE = await Bun.file(join(import.meta.dir, '..', 'prompts', 'usage-lifted.md')).text()

const mkTask = (over: Partial<Task> = {}): Task => ({
  task_id: 't4', branch: 'perf/r21', bead: 'hp-4', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: 'w4', pane_id: 'w4:p1', agent_status: 'done',
  phase: 'pr-review', phase_entered_at: SINCE - 60_000, escalated_from: null, head_sha_at_entry: null,
  pr: 257, ci: null, checkout_path: '/wt/t4', registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, merge_commit: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  stall: { at: SINCE - 60_000, run_at: 0, last_probe_at: SINCE + 7_200_000, probes: 3, undelivered: 0, holds: 0 },
  ...over,
})

function runWith(...tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.run_id = 'r1'
  run.phase = 'execute'
  run.phase_entered_at = 0
  run.orchestrator_pane = ORCHESTRATOR
  run.intake_closed = true
  run.tasks = tasks
  return run
}

const LINE: LimitLine = {
  label: 'session limit', when: '10:20am', zone: 'America/Managua',
  text: "⎿  You've hit your session limit · resets 10:20am (America/Managua)",
}
const lift = (pane: string, over: Partial<Lift> = {}): Lift => ({
  pane, resume: true,
  limit: { line: LINE, resetsAt: RESET, since: SINCE, checkedAt: SINCE, autoContinue: false },
  ...over,
})
const texts = (...tasks: Task[]): LiftTexts => textsFor(tasks.map((t) => [t, t.phase]))
const textsFor = (rendered: Array<[Task, TaskPhase]>): LiftTexts => ({
  resume: new Map(rendered.map(([t, phase]) => [t.task_id, { phase, text: `carry on with ${phase}` }])),
  note: NOTE,
  hpipe: 'hpipe',
})
const REARMED = { last_probe_at: NOW, probes: 0, undelivered: 0, holds: 0 }

test('a worker stopped by the limit is told to carry on, its ladder restarts, and the orchestrator hears once', () => {
  const t4 = mkTask()
  const t5 = mkTask({ task_id: 't5', pane_id: 'w5:p1', phase: 'implement' })
  const run = runWith(t4, t5)
  expect(liftEffect([lift('w4:p1'), lift('w5:p1')], texts(t4, t5), NOW)(run)).toEqual(new Set(['w4:p1', 'w5:p1']))

  expect(t4.stall).toMatchObject({ at: t4.phase_entered_at, run_at: 0, ...REARMED })
  expect(t4.stall?.undeliverable_since).toBeUndefined()
  const outbox = run.outbox ?? []
  expect(outbox.filter((e) => e.to === 'worker').map((e) => [e.task_id, e.kind, e.text])).toEqual([
    ['t4', 'resume', 'carry on with pr-review'],
    ['t5', 'resume', 'carry on with implement'],
  ])
  const notes = outbox.filter((e) => e.to === 'orchestrator')
  expect(notes).toHaveLength(1)
  expect(notes[0]?.text).toContain('10:20am (America/Managua)')
  expect(notes[0]?.text).toContain('t4 (pr-review), t5 (implement)')
  expect(notes[0]?.text).not.toContain('your own session')
})

test('each guard alone stops the resume, and the ladder is still re-armed', () => {
  const blocked: Array<[string, (t: Task, run: Run) => Lift, TaskPhase?]> = [
    ['the pane moved on', () => lift('w4:p1', { resume: false })],
    ['an orchestrator row', (t) => { t.phase = 'merge'; return lift('w4:p1') }],
    ['the phase changed during the limit', (t) => { t.phase_entered_at = SINCE + 1; return lift('w4:p1') }],
    ['the text is for another phase', () => lift('w4:p1'), 'implement'],
    ['a phase prompt is queued', (t, run) => {
      enqueue(run, { to: 'worker', taskId: t.task_id, text: 'review it' }, 0)
      return lift('w4:p1')
    }],
    ['a resume is already queued', (t, run) => {
      enqueue(run, { to: 'worker', taskId: t.task_id, text: 'nudged', kind: 'resume' }, 0)
      return lift('w4:p1')
    }],
    ['the worker was never briefed', (t) => { t.phase = 'research'; t.awaiting_brief = true; return lift('w4:p1') }],
  ]
  for (const [why, arrange, renderedFor] of blocked) {
    const t4 = mkTask()
    const run = runWith(t4)
    const theLift = arrange(t4, run)
    const rendered = textsFor([[t4, renderedFor ?? t4.phase]])
    const queuedBefore = (run.outbox ?? []).length
    liftEffect([theLift], rendered, NOW)(run)
    expect((run.outbox ?? []).length, why).toBe(queuedBefore)
    // A task in merge waits on the orchestrator, so the worker's pane lifting does not touch its ladder.
    if (t4.phase === 'merge') expect(t4.stall?.probes, why).toBe(3)
    else expect(t4.stall, why).toMatchObject(REARMED)
  }
})

test('the orchestrator\'s lift re-arms the run and every record waiting on it, not the workers', () => {
  const merging = mkTask({ task_id: 't2', pane_id: 'w2:p1', phase: 'merge' })
  const working = mkTask({ task_id: 't3', pane_id: 'w3:p1', phase: 'implement' })
  const run = runWith(merging, working)
  run.phase = 'branch-review'
  run.stall = { at: 0, run_at: 0, last_probe_at: SINCE, probes: 2, undelivered: 0, holds: 0 }
  const workerBefore = structuredClone(working.stall)
  liftEffect([lift(ORCHESTRATOR)], texts(), NOW)(run)
  expect(run.stall).toMatchObject(REARMED)
  expect(merging.stall).toMatchObject(REARMED)
  expect(working.stall).toEqual(workerBefore)
})

test('a stopped orchestrator is told to pick up where it was; one that carried on is told nothing', () => {
  const run = runWith()
  liftEffect([lift(ORCHESTRATOR)], texts(), NOW)(run)
  expect(run.outbox?.[0]?.text).toContain('your own session')
  expect(run.outbox?.[0]?.text).not.toContain('Told to carry on')

  const quiet = runWith()
  expect(liftEffect([lift(ORCHESTRATOR, { resume: false })], texts(), NOW)(quiet)).toEqual(new Set([ORCHESTRATOR]))
  expect(quiet.outbox ?? []).toEqual([])
})

test('a run the lifted panes do not touch is left alone', () => {
  const run = runWith(mkTask({ pane_id: 'w9:p1' }))
  const before = structuredClone(run)
  expect(liftEffect([lift('w4:p1')], texts(), NOW)(run).size).toBe(0)
  expect(run).toEqual(before)
})

test('applied to a fresh copy, the effect decides against that copy', () => {
  const t4 = mkTask()
  const fresh = runWith(structuredClone(t4))
  fresh.tasks[0]!.phase = 'ci'
  fresh.tasks[0]!.phase_entered_at = SINCE + 5
  liftEffect([lift('w4:p1')], texts(t4), NOW)(fresh)
  expect(fresh.outbox ?? []).toEqual([])
})

/** Marked at SINCE, its clock then moved to `liftAt`. */
const limited = (liftAt = NOW) => {
  const clock = { now: SINCE }
  const limits = new UsageLimits(() => clock.now, () => {})
  limits.observe('w4:p1', { status: 'done', line: LINE, boxSeen: true, autoContinue: false })
  clock.now = liftAt
  return limits
}
const SCREEN = [`  ${LINE.text}`, '', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n')
const io = (status: AgentStatus = 'done', screen = SCREEN) => ({
  paneReadStyled: async () => screen, agentStatus: async () => status,
})
const deps = (over: Partial<Parameters<typeof liftLimits>[2]> = {}) => {
  const saved: Run[] = []
  return {
    saved,
    deps: {
      io: io(),
      save: async (run: Run, effect: RunEffect): Promise<SaveOutcome> => { saved.push(run); void effect; return 'saved' },
      renderResume: async (task: Task) => `carry on with ${task.phase}`,
      note: async () => NOTE,
      hpipe: 'hpipe',
      now: () => NOW,
      ...over,
    },
  }
}

test('liftLimits saves each touched run once and lifts the mark only after', async () => {
  const limits = limited()
  const run = runWith(mkTask())
  const { saved, deps: d } = deps()
  expect(await liftLimits(limits, [run, runWith(mkTask({ pane_id: 'w9:p1' }))], d)).toEqual(new Set())
  expect(saved).toEqual([run])
  expect(limits.isLimited('w4:p1')).toBe(false)
  expect(run.outbox?.some((e) => e.kind === 'resume')).toBe(true)
})

test('nothing is due before the reset plus the grace', async () => {
  const limits = limited(NOW - 1)
  const { saved, deps: d } = deps()
  await liftLimits(limits, [runWith(mkTask())], d)
  expect(saved).toEqual([])
  expect(limits.isLimited('w4:p1')).toBe(true)
})

test('a save that lands on a fresh copy reports the run stale; one that throws keeps the mark', async () => {
  const run = runWith(mkTask())
  const reapplied = deps({ save: async () => 'reapplied' })
  const limits = limited()
  expect(await liftLimits(limits, [run], reapplied.deps)).toEqual(new Set([run]))
  expect(limits.isLimited('w4:p1')).toBe(false)

  const failing = deps({ save: async () => { throw new StaleRunError('r1') } })
  const kept = limited()
  const other = runWith(mkTask())
  expect(await liftLimits(kept, [other], failing.deps)).toEqual(new Set([other]))
  expect(kept.isLimited('w4:p1')).toBe(true)
})

test('a pane found working, with the line gone, or continuing by itself is re-armed but not resumed', async () => {
  const cases: Array<[string, ReturnType<typeof io>]> = [
    ['working', io('working')],
    ['line gone', io('done', ['⏺ carried on', '', '─'.repeat(40), '❯ ', '─'.repeat(40)].join('\n'))],
    ['auto-continue', io('done', [
      `  ${LINE.text}`, '  Usage limit reached · continuing automatically at 10:20am · esc to cancel', '',
      '─'.repeat(40), '❯ ', '─'.repeat(40),
    ].join('\n'))],
  ]
  for (const [why, paneIO] of cases) {
    const run = runWith(mkTask())
    await liftLimits(limited(), [run], deps({ io: paneIO }).deps)
    expect(run.outbox ?? [], why).toEqual([])
    expect(run.tasks[0]?.stall, why).toMatchObject(REARMED)
  }
})
