import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDeliveryHealth, writeDeliveryHealth } from '../src/lib/delivery-health'
import { listRuns, loadRun, newRun, saveOrReapply, saveRun } from '../src/lib/ledger'
import { enqueue, settleOutbox } from '../src/lib/outbox'
import { hpipeCommand, renderPrompt } from '../src/lib/render'
import type { AgentStatus, QueuedEvent, Run, Task } from '../src/lib/types'
import { DeliveryGate, flushDeliveries, makeCourier, outboxPending, type PromptIO } from '../src/supervisor/courier'
import { deliveriesFor } from '../src/supervisor/deliver'
import { applyStalls, type StallDeps, taskStallCandidates } from '../src/supervisor/stall'
import { liftLimits } from '../src/supervisor/usage-lift'
import { checkLimits, LIFT_GRACE_MS, limitedNow, UsageLimits } from '../src/supervisor/usage-limits'
import { beadTaskFields } from './helpers/bead-fields'

/**
 * The limit step, the courier, the stall step and the lift step driven in
 * `main.ts`'s order against a real ledger, with only herdr faked. Unit tests with
 * fakes have missed live-only wiring bugs before.
 */

const ROOT = join(import.meta.dir, '..')
const ORCHESTRATOR = 'w1:p1'
const WORKER = 'w4:p1'
const HIT = Date.parse('2026-10-11T12:34:14Z')
const RESET = Date.parse('2026-10-11T16:20:00Z')
const RULE = '─'.repeat(40)
const box = (...transcript: string[]) => [...transcript, '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n')
const LIMITED = box(
  '⏺ Dispatched the PR reviewer.',
  "  ⎿  You've hit your session limit · resets 10:20am (America/Managua)",
  '     /upgrade to increase your usage limit.',
  '', '✻ Worked for 0s · done 6:34 AM',
)

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function herdrFake() {
  const screens: Record<string, string> = { [WORKER]: LIMITED, [ORCHESTRATOR]: box('⏺ Waiting on the workers.') }
  const statuses: Record<string, AgentStatus> = { [WORKER]: 'done', [ORCHESTRATOR]: 'idle' }
  const prompts: Array<{ pane: string; text: string }> = []
  const io: PromptIO = {
    agentPromptConfirmed: async (pane, text) => {
      prompts.push({ pane, text })
      return { ok: true }
    },
    agentStatus: async (pane) => statuses[pane] ?? 'unknown',
    agentSendKeys: async () => ({ ok: true }),
    paneReadStyled: async (pane) => screens[pane] ?? '',
  }
  return { io, screens, statuses, prompts }
}

async function seedRun(): Promise<Run> {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'limits' })
  run.phase = 'execute'
  run.intake_closed = true
  run.phase_entered_at = 0
  run.orchestrator_pane = ORCHESTRATOR
  const task: Task = {
    task_id: 't4', branch: 'perf/r21', bead: 'hp-4', surface: 'core', depends_on: [], files: [],
    keep_worktree: false, workspace_id: 'w4', pane_id: WORKER, agent_status: 'done',
    phase: 'pr-review', phase_entered_at: HIT - 600_000, escalated_from: null, head_sha_at_entry: null,
    pr: 258, ci: null, checkout_path: '/wt/t4', registered_at: 0, adopted_at: 0,
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, merge_commit: null, ...beadTaskFields(), passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  }
  run.tasks = [task]
  await saveRun(dir, run)
  return run
}

const statusEvents = (pane: string, ...statuses: AgentStatus[]): QueuedEvent[] =>
  statuses.map((agent_status, i) => ({ kind: 'pane.agent_status_changed', session: 'personal', at: i, pane_id: pane, agent_status }))

async function deliver(send: ReturnType<typeof makeCourier>, run: Run): Promise<void> {
  const settled = await flushDeliveries(deliveriesFor(outboxPending(run)), send, () => {})
  settleOutbox(run, settled.get(run) ?? [], Date.now())
  await saveOrReapply(dir, run, [(fresh) => settleOutbox(fresh, settled.get(run) ?? [], Date.now())])
}

function stallDeps(gate: DeliveryGate, io: PromptIO, clock: { now: number }, sent: string[]): StallDeps {
  return {
    probeMax: 3,
    now: () => clock.now,
    agentStatus: (pane) => io.agentStatus(pane),
    persist: (run, effect) => saveOrReapply(dir, run, effect ? [effect] : []),
    probe: async (c) => { sent.push(`probe ${c.task?.task_id}`); return { ok: true } },
    escalationText: async () => 'escalated',
    queueEscalation: (c) => { sent.push(`escalate ${c.task?.task_id}`) },
    limited: limitedNow(gate.limits, io),
  }
}

async function throughTheLimit(heldPhasePrompt: boolean) {
  dir = mkdtempSync(join(tmpdir(), 'hpipe-limits-'))
  const clock = { now: HIT }
  const herdr = herdrFake()
  const limits = new UsageLimits(() => clock.now, () => {})
  const gate = new DeliveryGate({ sendsPerTick: 8, backoffMaxMs: 300_000, tickBudgetMs: 20_000 }, () => clock.now, () => {}, limits)
  const send = makeCourier(gate, herdr.io, 15_000)
  const runPanes = new Set([ORCHESTRATOR, WORKER])
  let run = await seedRun()

  // The 429 lands: herdr reports the pane working, then done, in one drain.
  gate.beginTick(runPanes)
  await checkLimits(limits, herdr.io, statusEvents(WORKER, 'working', 'done'), runPanes)
  expect(limits.isLimited(WORKER)).toBe(true)

  // A prompt owed to the worker meanwhile is held, not typed into the wall.
  if (heldPhasePrompt) {
    enqueue(run, { to: 'worker', taskId: 't4', text: 'review the PR again' }, clock.now)
    await saveRun(dir, run)
    await deliver(send, run)
    expect(herdr.prompts).toEqual([])
  }

  // Hours pass with the ladder at the top: nothing is probed or escalated.
  const sent: string[] = []
  run = (await loadRun(dir, 'personal', run.run_id)) as Run
  run.tasks[0]!.stall = {
    at: run.tasks[0]!.phase_entered_at, run_at: 0, last_probe_at: HIT, probes: 3, undelivered: 0, holds: 0,
  }
  await saveRun(dir, run)
  for (clock.now = HIT + 45 * 60_000; clock.now < RESET + LIFT_GRACE_MS; clock.now += 45 * 60_000) {
    gate.beginTick(runPanes)
    run = (await loadRun(dir, 'personal', run.run_id)) as Run
    await applyStalls(taskStallCandidates([run], clock.now, 45, 3), stallDeps(gate, herdr.io, clock, sent))
  }
  expect(sent).toEqual([])
  expect((await loadRun(dir, 'personal', run.run_id))?.tasks[0]?.phase).toBe('pr-review')

  // The reset plus the grace: the lift saves the re-arm, and any resume, before any ladder is read.
  clock.now = RESET + LIFT_GRACE_MS
  gate.beginTick(runPanes)
  const touched = await liftLimits(limits, {
    io: herdr.io,
    listRuns: () => listRuns(dir, 'personal'),
    save: (r, effect) => saveOrReapply(dir, r, [effect]),
    renderResume: (task) => renderPrompt(ROOT, 'usage-resume', { phase: task.phase, task_id: task.task_id, branch: task.branch }),
    note: () => Bun.file(join(ROOT, 'prompts', 'usage-lifted.md')).text(),
    hpipe: hpipeCommand(ROOT),
    now: () => clock.now,
  })
  expect(touched).toEqual(new Set([run.run_id]))
  expect(limits.isLimited(WORKER)).toBe(false)
  run = (await loadRun(dir, 'personal', run.run_id)) as Run
  expect(run.tasks[0]?.stall).toMatchObject({ probes: 0, last_probe_at: clock.now })
  await applyStalls(taskStallCandidates([run], clock.now, 45, 3), stallDeps(gate, herdr.io, clock, sent))
  expect(sent).toEqual([])

  gate.beginTick(runPanes)
  await deliver(send, run)
  expect((await loadRun(dir, 'personal', run.run_id))?.outbox ?? []).toEqual([])
  return herdr.prompts
}

test('a worker stopped by the limit is held, never escalated, and told to carry on at the reset', async () => {
  const prompts = await throughTheLimit(false)
  const to = (pane: string) => prompts.filter((p) => p.pane === pane).map((p) => p.text)
  expect(prompts).toHaveLength(2)
  expect(to(WORKER)[0]).toContain('Carry on with `pr-review` from where you')
  expect(to(ORCHESTRATOR)[0]).toContain('t4 (pr-review)')
})

test('a phase prompt held through the limit restarts the worker by itself: no resume, no note', async () => {
  const prompts = await throughTheLimit(true)
  expect(prompts.map((p) => p.pane)).toEqual([WORKER])
  expect(prompts[0]?.text).toContain('review the PR again')
  expect(prompts[0]?.text).not.toContain('Carry on')
})

test('a supervisor restarted mid-limit carries the mark over and still lifts it at the reset', async () => {
  dir = mkdtempSync(join(tmpdir(), 'hpipe-limits-'))
  const clock = { now: HIT }
  const herdr = herdrFake()
  const before = new UsageLimits(() => clock.now, () => {})
  await checkLimits(before, herdr.io, statusEvents(WORKER, 'done'), new Set([WORKER]))
  await writeDeliveryHealth(dir, 'personal', {
    pid: 1, written_at: clock.now, panes: before.holds(), limits: before.snapshot(),
  })

  clock.now = HIT + 3_600_000
  const after = new UsageLimits(() => clock.now, () => {}, (await readDeliveryHealth(dir, 'personal'))?.limits)
  expect(after.isLimited(WORKER)).toBe(true)
  expect(after.get(WORKER)?.since).toBe(HIT)
  expect(after.recheckDue()).toEqual([WORKER])
  await checkLimits(after, herdr.io, [], new Set([WORKER]))
  expect(after.isLimited(WORKER)).toBe(true)
  clock.now = RESET + LIFT_GRACE_MS
  expect(after.due()).toEqual([WORKER])
})
