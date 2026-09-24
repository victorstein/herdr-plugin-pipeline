import { expect, test } from 'bun:test'
import type { CallResult } from '../src/lib/herdr'
import { newRun } from '../src/lib/ledger'
import { enqueue } from '../src/lib/outbox'
import type { AgentStatus, QueuedEvent, Run, Task } from '../src/lib/types'
import {
  BACKOFF_BASE_MS, DeliveryGate, flushDeliveries, makeCourier, outboxPending, type PromptIO,
  queuePending, readyPanes, type Send, sendConfirmed,
} from '../src/supervisor/courier'
import { deliveriesFor } from '../src/supervisor/deliver'

interface FakeIO extends PromptIO { calls: string[] }

function fakeIO(opts: {
  prompt?: (pane: string) => CallResult<unknown>
  status?: AgentStatus
} = {}): FakeIO {
  const calls: string[] = []
  return {
    calls,
    agentPromptConfirmed: async (pane, text) => {
      calls.push(`prompt ${pane} ${text}`)
      return opts.prompt ? opts.prompt(pane) : { ok: true }
    },
    agentStatus: async (pane) => { calls.push(`status ${pane}`); return opts.status ?? 'idle' },
    agentSendKeys: async (pane, keys) => { calls.push(`keys ${pane} ${keys.join(' ')}`); return { ok: true } },
  }
}

const stalled = (): CallResult<unknown> => ({ ok: false, code: 'agent_prompt_stalled' })

// ——— sendConfirmed ———

test('a prompt the agent took up is delivered with no read-back', async () => {
  const io = fakeIO()
  expect((await sendConfirmed(io, 'w1:p1', 'hi', 15000)).ok).toBe(true)
  expect(io.calls).toEqual(['prompt w1:p1 hi'])
})

test('a stalled prompt on an idle agent is cleared from the input box and reported failed — #18', async () => {
  const io = fakeIO({ prompt: stalled, status: 'idle' })
  const result = await sendConfirmed(io, 'w1:p1', 'hi', 15000)
  expect(result).toMatchObject({ ok: false, code: 'agent_prompt_stalled' })
  expect(io.calls).toEqual(['prompt w1:p1 hi', 'status w1:p1', 'keys w1:p1 ctrl+c'])
})

test('a stalled prompt the agent has since taken up counts as delivered, and nothing is pressed', async () => {
  for (const status of ['working', 'blocked'] as const) {
    const io = fakeIO({ prompt: stalled, status })
    expect((await sendConfirmed(io, 'w1:p1', 'hi', 15000)).ok, status).toBe(true)
    expect(io.calls.some((c) => c.startsWith('keys')), status).toBe(false)
  }
})

test('a stalled prompt on an agent that no longer reads as one is not touched', async () => {
  const io = fakeIO({ prompt: stalled, status: 'unknown' })
  expect((await sendConfirmed(io, 'w1:p1', 'hi', 15000)).ok).toBe(false)
  expect(io.calls.some((c) => c.startsWith('keys'))).toBe(false)
})

test('a rejection before anything was written needs no read-back', async () => {
  const io = fakeIO({ prompt: () => ({ ok: false, code: 'agent_not_found' }) })
  expect((await sendConfirmed(io, 'w1:p1', 'hi', 15000)).code).toBe('agent_not_found')
  expect(io.calls).toEqual(['prompt w1:p1 hi'])
})

// ——— DeliveryGate ———

const gateAt = (clock: { now: number }, sendsPerTick = 8, backoffMaxMs = 300_000) =>
  new DeliveryGate({ sendsPerTick, backoffMaxMs }, () => clock.now, () => {})

test('a pane missing from herdr\'s pane list is held without a send — #24', async () => {
  const clock = { now: 0 }
  const gate = gateAt(clock)
  gate.beginTick(new Set(['w1:p1']))
  const io = fakeIO()
  const send = makeCourier(gate, io, 15000)
  expect(await send('w7:p1', 'hi')).toEqual({ ok: false, code: 'pane_gone', held: 'pane_gone' })
  expect(io.calls).toEqual([])
})

test('a failed pane list does not hold every pane', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set())
  expect(gate.holdFor('w7:p1')).toBeNull()
})

test('a pane that fails is backed off exponentially up to the cap — #25', () => {
  const clock = { now: 0 }
  const gate = gateAt(clock, 8, 20_000)
  gate.beginTick(new Set(['w1:p1']))
  const delays: number[] = []
  for (let i = 0; i < 4; i++) {
    gate.record('w1:p1', { ok: false, code: 'agent_not_found' })
    const start = clock.now
    while (gate.holdFor('w1:p1') === 'backoff') clock.now += 1000
    delays.push(clock.now - start)
    gate.beginTick(new Set(['w1:p1']))
  }
  expect(delays).toEqual([BACKOFF_BASE_MS, 2 * BACKOFF_BASE_MS, 20_000, 20_000])
})

test('a dead orchestrator costs a bounded number of sends over the berean-os 13 hours — #25', async () => {
  const clock = { now: 0 }
  const gate = gateAt(clock)
  const io = fakeIO({ prompt: () => ({ ok: false, code: 'agent_not_found' }) })
  const send = makeCourier(gate, io, 15000)
  for (; clock.now < 13 * 3_600_000; clock.now += 1000) {
    gate.beginTick(new Set(['w1:p1']))
    await send('w1:p1', 'digest')
  }
  const sends = io.calls.filter((c) => c.startsWith('prompt')).length
  // 13h at one send per 5-minute cap, plus the ramp up to it.
  expect(sends).toBeLessThan(170)
  expect(sends).toBeGreaterThan(150)
})

test('a pane that reports ready again is tried at once, not at the end of its backoff', () => {
  const clock = { now: 0 }
  const gate = gateAt(clock)
  gate.beginTick(new Set(['w1:p1']))
  for (let i = 0; i < 6; i++) gate.record('w1:p1', { ok: false, code: 'agent_not_found' })
  expect(gate.holdFor('w1:p1')).toBe('backoff')
  gate.wake('w1:p1')
  expect(gate.holdFor('w1:p1')).toBeNull()
})

test('a success clears the pane\'s failure streak', () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w1:p1']))
  gate.record('w1:p1', { ok: false, code: 'agent_blocked' })
  gate.record('w1:p1', { ok: true })
  expect(gate.failuresFor('w1:p1')).toBe(0)
  expect(gate.holdFor('w1:p1')).toBeNull()
})

test('a code about the text, not the pane, does not back the pane off', () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w1:p1']))
  gate.record('w1:p1', { ok: false, code: 'empty_agent_prompt' })
  expect(gate.holdFor('w1:p1')).toBeNull()
})

test('the per-tick budget is shared by every send and resets each tick — #25', async () => {
  const gate = gateAt({ now: 0 }, 2)
  gate.beginTick(new Set(['w1:p1', 'w7:p1', 'w8:p1']))
  const io = fakeIO()
  const send = makeCourier(gate, io, 15000)
  expect((await send('w1:p1', 'a')).ok).toBe(true)
  expect((await send('w7:p1', 'b')).ok).toBe(true)
  expect(await send('w8:p1', 'c')).toMatchObject({ ok: false, held: 'budget' })
  gate.beginTick(new Set(['w1:p1', 'w7:p1', 'w8:p1']))
  expect((await send('w8:p1', 'c')).ok).toBe(true)
})

test('only a ready or newly detected agent wakes a pane', () => {
  const ev = (over: Partial<QueuedEvent>): QueuedEvent =>
    ({ kind: 'pane.agent_status_changed', session: 's', at: 0, ...over })
  expect(readyPanes([
    ev({ pane_id: 'a', agent_status: 'idle' }),
    ev({ pane_id: 'b', agent_status: 'working' }),
    ev({ pane_id: 'c', agent_status: 'done' }),
    ev({ kind: 'pane.agent_detected', pane_id: 'd' }),
    ev({ kind: 'pane.exited', pane_id: 'e' }),
  ])).toEqual(['a', 'c', 'd'])
})

// ——— the outbox round trip ———

function mkRun(): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = [{
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
    depends_on: [], files: [], keep_worktree: false,
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase: 'spec', phase_entered_at: 1000, escalated_from: null,
    head_sha_at_entry: null, pr: null, ci: null, checkout_path: '/r/wt',
    registered_at: 0, adopted_at: 0,
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  } satisfies Task]
  return run
}

test('a prompt with a body is written to the outbox; its event lines stay this tick\'s only', () => {
  const run = mkRun()
  const ephemeral = queuePending(run, [
    { paneId: 'w1:p1', run, text: 'next', events: ['- e1'], isOrchestrator: true, phaseNote: ' → x' },
    { paneId: 'w7:p1', run, text: 'spec now', events: [], isOrchestrator: false, taskId: 't1' },
    { paneId: 'w1:p1', run, text: '', events: ['- e2'], isOrchestrator: true },
  ], 0)
  expect(run.outbox?.map((e) => [e.to, e.task_id, e.text, e.phase_note])).toEqual([
    ['orchestrator', null, 'next', ' → x'],
    ['worker', 't1', 'spec now', undefined],
  ])
  expect(ephemeral.map((p) => [p.text, p.events])).toEqual([['', ['- e1']], ['', ['- e2']]])
})

test('outbox entries come back as pending with the footer on orchestrator ones', () => {
  const run = mkRun()
  enqueue(run, { to: 'orchestrator', taskId: null, text: 'a', phaseNote: ' → x' }, 0)
  enqueue(run, { to: 'worker', taskId: 't1', text: 'b' }, 0)
  const pending = outboxPending(run, 'also waiting on you')
  expect(pending.map((p) => [p.paneId, p.isOrchestrator, p.footer, p.phaseNote])).toEqual([
    ['w1:p1', true, 'also waiting on you', ' → x'],
    ['w7:p1', false, undefined, undefined],
  ])
})

test('a stale entry, a paneless recipient and a finished run yield nothing to send', () => {
  const run = mkRun()
  enqueue(run, { to: 'worker', taskId: 't1', text: 'b' }, 0)
  ;(run.tasks[0] as Task).pane_id = null
  expect(outboxPending(run)).toEqual([])

  const moved = mkRun()
  enqueue(moved, { to: 'worker', taskId: 't1', text: 'b' }, 0)
  ;(moved.tasks[0] as Task).phase_entered_at = 2000
  expect(outboxPending(moved)).toEqual([])

  const done = mkRun()
  enqueue(done, { to: 'orchestrator', taskId: null, text: 'a' }, 0)
  done.phase = 'done'
  expect(outboxPending(done)).toEqual([])
})

test('an escalated run still delivers what it owes the orchestrator', () => {
  const run = mkRun()
  run.phase = 'escalated'
  enqueue(run, { to: 'orchestrator', taskId: null, text: 'escalated' }, 0)
  expect(outboxPending(run)).toHaveLength(1)
})

test('a flushed delivery settles every entry it carried, and a held one settles nothing', async () => {
  const run = mkRun()
  enqueue(run, { to: 'orchestrator', taskId: null, text: 'a' }, 0)
  enqueue(run, { to: 'worker', taskId: 't1', text: 'b' }, 0)
  const deliveries = deliveriesFor(outboxPending(run))

  const outcomes: Record<string, Awaited<ReturnType<Send>>> = {
    'w1:p1': { ok: true },
    'w7:p1': { ok: false, code: 'pane_gone', held: 'pane_gone' },
  }
  const settled = await flushDeliveries(deliveries, async (pane) => outcomes[pane] as never)
  expect(settled.get(run)).toEqual([
    { id: run.outbox?.[0]?.id as string, ok: true, code: undefined, permanent: false },
  ])
})

test('a refused delivery is given up on, loudly, so it cannot block its pane', async () => {
  const run = mkRun()
  enqueue(run, { to: 'worker', taskId: 't1', text: 'b' }, 0)
  const logged: string[] = []
  const settled = await flushDeliveries(
    deliveriesFor(outboxPending(run)),
    async () => ({ ok: false, code: 'invalid_agent_argument' }),
    (message) => logged.push(message),
  )
  expect(settled.get(run)?.[0]).toMatchObject({ ok: false, permanent: true })
  expect(logged[0]).toContain('giving up on 1 prompt(s) to w7:p1: invalid_agent_argument')
})
