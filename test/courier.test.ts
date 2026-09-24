import { expect, test } from 'bun:test'
import type { CallResult } from '../src/lib/herdr'
import { newRun } from '../src/lib/ledger'
import { enqueue } from '../src/lib/outbox'
import type { AgentStatus, QueuedEvent, Run, Task } from '../src/lib/types'
import {
  BACKOFF_BASE_MS, boundedProbeSend, boxHoldsOnly, CLEAR_MIN_INTERVAL_MS, ClearGuard, DeliveryGate, flushDeliveries,
  inputBoxText, makeCourier, outboxPending, type PromptIO, queuePending, readyPanes, type Send,
  PROBE_DEFERRALS_MAX, sendConfirmed, STUCK_INPUT,
} from '../src/supervisor/courier'
import { deliveriesFor } from '../src/supervisor/deliver'

interface FakeIO extends PromptIO { calls: string[] }

const RULE = '─'.repeat(40)
/** What `pane read --source visible` returned for an idle Claude, measured live. */
const claudeScreen = (box: string) =>
  ['', '  ◐ medium · /effort', RULE, `❯ ${box}`, RULE, '  ⏵⏵ auto mode on'].join('\n')
const STUCK = claudeScreen('Please merge it once CI is green.')
/** A send whose text STUCK's box holds a piece of. */
const SENT = 'Your PR is green. Please merge it once CI is green.'

function fakeIO(opts: {
  prompt?: (pane: string) => CallResult<unknown>
  status?: AgentStatus
  /** Read in order, one per status call, before falling back to `status`. */
  statuses?: AgentStatus[]
  screen?: string
} = {}): FakeIO {
  const calls: string[] = []
  return {
    calls,
    agentPromptConfirmed: async (pane, text) => {
      calls.push(`prompt ${pane} ${text}`)
      return opts.prompt ? opts.prompt(pane) : { ok: true }
    },
    agentStatus: async (pane) => {
      calls.push(`status ${pane}`)
      return opts.statuses?.shift() ?? opts.status ?? 'idle'
    },
    agentSendKeys: async (pane, keys) => { calls.push(`keys ${pane} ${keys.join(' ')}`); return { ok: true } },
    paneRead: async (pane) => { calls.push(`read ${pane}`); return opts.screen ?? STUCK },
  }
}

const stalled = (): CallResult<unknown> => ({ ok: false, code: 'agent_prompt_stalled' })
const presses = (io: FakeIO) => io.calls.filter((c) => c.startsWith('keys'))

// ——— sendConfirmed ———

test('a prompt the agent took up is delivered with no read-back', async () => {
  const io = fakeIO()
  expect((await sendConfirmed(io, 'w1:p1', SENT, 15000, new ClearGuard())).ok).toBe(true)
  expect(io.calls).toEqual([`prompt w1:p1 ${SENT}`])
})

test('a stalled prompt left in an idle agent\'s box is cleared and reported failed — #18', async () => {
  const io = fakeIO({ prompt: stalled, status: 'idle' })
  const result = await sendConfirmed(io, 'w1:p1', SENT, 15000, new ClearGuard())
  expect(result).toMatchObject({ ok: false, code: 'agent_prompt_stalled' })
  expect(presses(io)).toEqual(['keys w1:p1 ctrl+c'])
})

test('a stalled prompt the agent has since taken up counts as delivered, and nothing is pressed', async () => {
  for (const status of ['working', 'blocked'] as const) {
    const io = fakeIO({ prompt: stalled, status })
    expect((await sendConfirmed(io, 'w1:p1', SENT, 15000, new ClearGuard())).ok, status).toBe(true)
    expect(presses(io), status).toEqual([])
  }
})

test('a stalled prompt on an agent that no longer reads as one is not touched', async () => {
  const io = fakeIO({ prompt: stalled, status: 'unknown' })
  expect((await sendConfirmed(io, 'w1:p1', SENT, 15000, new ClearGuard())).ok).toBe(false)
  expect(presses(io)).toEqual([])
})

test('an empty box is never pressed: ctrl+c there arms Claude\'s exit', async () => {
  const io = fakeIO({ prompt: stalled, screen: claudeScreen('') })
  await sendConfirmed(io, 'w1:p1', SENT, 15000, new ClearGuard())
  expect(presses(io)).toEqual([])
})

test('a screen with no recognisable input box is never pressed', async () => {
  for (const screen of ['', 'some shell $ ', `${RULE}\n   Rewind\n   ❯ (current)\n   Esc to cancel`]) {
    const io = fakeIO({ prompt: stalled, screen })
    await sendConfirmed(io, 'w1:p1', SENT, 15000, new ClearGuard())
    expect(presses(io), JSON.stringify(screen)).toEqual([])
  }
})

test('a rejection before anything was written needs no read-back', async () => {
  const io = fakeIO({ prompt: () => ({ ok: false, code: 'agent_not_found' }) })
  const result = await sendConfirmed(io, 'w1:p1', SENT, 15000, new ClearGuard())
  expect(result.code).toBe('agent_not_found')
  expect(io.calls).toEqual([`prompt w1:p1 ${SENT}`])
})

// ——— the ctrl+c invariant ———

test('no pane is ever sent two ctrl+c inside CLEAR_MIN_INTERVAL_MS, however often sends stall', async () => {
  // Deliberately bypasses the delivery gate: the invariant must hold on its own,
  // whatever the backoff, the budget or a wake does to how often a pane is tried.
  const clock = { now: 0 }
  const clears = new ClearGuard(() => clock.now)
  const pressedAt = new Map<string, number[]>()
  const io: PromptIO = {
    agentPromptConfirmed: async () => stalled(),
    agentStatus: async () => 'idle',
    paneRead: async () => STUCK,
    agentSendKeys: async (pane) => {
      pressedAt.set(pane, [...(pressedAt.get(pane) ?? []), clock.now])
      return { ok: true }
    },
  }
  for (let step = 0; step < 2000; step++) {
    clock.now += [0, 1, 250, 900, 1999, 3000][step % 6] as number
    await sendConfirmed(io, step % 3 === 0 ? 'w7:p1' : 'w1:p1', SENT, 15000, clears)
  }
  expect([...pressedAt.keys()].sort()).toEqual(['w1:p1', 'w7:p1'])
  for (const [pane, times] of pressedAt) {
    expect(times.length, pane).toBeGreaterThan(1)
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number), pane)
        .toBeGreaterThanOrEqual(CLEAR_MIN_INTERVAL_MS)
    }
  }
})

test('the press interval is per pane: one pane\'s clear does not block another\'s', () => {
  const clears = new ClearGuard(() => 0)
  expect(clears.claim('w1:p1')).toBe(true)
  expect(clears.claim('w1:p1')).toBe(false)
  expect(clears.claim('w7:p1')).toBe(true)
})

test('a press refused by a failed check does not consume the pane\'s interval', async () => {
  const clock = { now: 0 }
  const clears = new ClearGuard(() => clock.now)
  await sendConfirmed(fakeIO({ prompt: stalled, screen: claudeScreen('') }), 'w1:p1', SENT, 1, clears)
  const io = fakeIO({ prompt: stalled })
  await sendConfirmed(io, 'w1:p1', SENT, 1, clears)
  expect(presses(io)).toEqual(['keys w1:p1 ctrl+c'])
})

test('the input box is read from between the two rules that frame it', () => {
  expect(inputBoxText(STUCK)).toBe('Please merge it once CI is green.')
  expect(inputBoxText(claudeScreen(''))).toBe('')
  expect(inputBoxText([RULE, '❯ first stray', '  second stray', RULE].join('\n')))
    .toBe('first stray\n  second stray')
  expect(inputBoxText('no box here')).toBeNull()
})


// ——— whose text is in the box ———

/** The reviewer's fixture: a human's half-typed message with a paste in it. */
const DRAFT = [RULE, '❯ hey claude, before you merge, can you also check the',
  '  migration order [Pasted text #1 +40 lines]', RULE].join('\n')

test('a box holding a human\'s draft and a paste is never cleared, and is reported stuck', async () => {
  const io = fakeIO({ prompt: stalled, screen: DRAFT })
  const result = await sendConfirmed(io, 'w7:p1', 'Digest: t1 entered spec-review', 15000, new ClearGuard())
  expect(result.code).toBe(STUCK_INPUT)
  expect(presses(io)).toEqual([])
})

test('the orchestrator pane is never cleared, even when the box holds only this send', async () => {
  const io = fakeIO({ prompt: stalled, screen: claudeScreen('[Pasted text #1 +40 lines]') })
  const result = await sendConfirmed(io, 'w1:p1', SENT, 15000, new ClearGuard(), true)
  expect(result.code).toBe(STUCK_INPUT)
  expect(presses(io)).toEqual([])
})

test('a worker box holding only this send — collapsed, wrapped or a tail fragment — is cleared', async () => {
  for (const box of [
    '[Pasted text #1 +40 lines]',
    'Your PR is green. Please\n  merge it once CI is green.',
    '[Pasted text #1]e merge it once CI is green.',
  ]) {
    const io = fakeIO({ prompt: stalled, screen: claudeScreen(box) })
    await sendConfirmed(io, 'w7:p1', SENT, 15000, new ClearGuard())
    expect(presses(io), box).toEqual(['keys w7:p1 ctrl+c'])
  }
})

test('boxHoldsOnly accepts only placeholders and pieces of the sent text', () => {
  expect(boxHoldsOnly('Please merge it once CI', SENT)).toBe(true)
  expect(boxHoldsOnly('merge it', SENT)).toBe(false)
  expect(boxHoldsOnly('[Pasted text #3 +2 lines]', SENT)).toBe(true)
  expect(boxHoldsOnly('Please merge it once CI\nand also', SENT)).toBe(false)
  expect(boxHoldsOnly('ship it', SENT)).toBe(false)
})

test('an agent that leaves idle between the box read and the press is not pressed', async () => {
  // Status reads: after the stall, before the box read, immediately before the press.
  const io = fakeIO({ prompt: stalled, statuses: ['idle', 'idle', 'working'] })
  await sendConfirmed(io, 'w7:p1', SENT, 15000, new ClearGuard())
  expect(presses(io)).toEqual([])
})

test('a stuck pane gets nothing more until its box is empty, then delivery resumes', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w7:p1']))
  let screen = DRAFT
  let prompts = 0
  const io: PromptIO = {
    agentPromptConfirmed: async () => { prompts += 1; return prompts === 1 ? stalled() : { ok: true } },
    agentStatus: async () => 'idle',
    agentSendKeys: async () => ({ ok: true }),
    paneRead: async () => screen,
  }
  const send = makeCourier(gate, io, 15000)
  expect((await send('w7:p1', 'a')).code).toBe(STUCK_INPUT)
  gate.wake('w7:p1')
  expect(await send('w7:p1', 'b')).toEqual({ ok: false, code: STUCK_INPUT, held: STUCK_INPUT })
  expect(prompts).toBe(1)

  screen = claudeScreen('')
  expect((await send('w7:p1', 'b')).ok).toBe(true)
  expect(prompts).toBe(2)
})

// ——— DeliveryGate ———

const gateAt = (clock: { now: number }, sendsPerTick = 8, backoffMaxMs = 300_000, tickBudgetMs = 20_000) =>
  new DeliveryGate({ sendsPerTick, backoffMaxMs, tickBudgetMs }, () => clock.now, () => {})

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
  expect(gate.admit('w7:p1')).toBeNull()
})

test('a pane that fails is backed off exponentially up to the cap — #25', () => {
  const clock = { now: 0 }
  const gate = gateAt(clock, 8, 20_000)
  gate.beginTick(new Set(['w1:p1']))
  const delays: number[] = []
  for (let i = 0; i < 4; i++) {
    gate.record('w1:p1', { ok: false, code: 'agent_not_found' })
    const start = clock.now
    while (gate.admit('w1:p1') === 'backoff') clock.now += 1000
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
  expect(gate.admit('w1:p1')).toBe('backoff')
  gate.wake('w1:p1')
  expect(gate.admit('w1:p1')).toBeNull()
})

test('a success clears the pane\'s failure streak', () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w1:p1']))
  gate.record('w1:p1', { ok: false, code: 'agent_blocked' })
  gate.record('w1:p1', { ok: true })
  expect(gate.failuresFor('w1:p1')).toBe(0)
  expect(gate.admit('w1:p1')).toBeNull()
})

test('a code about the text, not the pane, does not back the pane off', () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w1:p1']))
  gate.record('w1:p1', { ok: false, code: 'empty_agent_prompt' })
  expect(gate.admit('w1:p1')).toBeNull()
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

test('an unknown herdr code keeps the prompt queued and backs the pane off — it is not dropped', async () => {
  const run = mkRun()
  enqueue(run, { to: 'orchestrator', taskId: null, text: 'a' }, 0)
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w1:p1']))
  const io = fakeIO({ prompt: () => ({ ok: false, code: 'agent_not_running' }) })
  const settled = await flushDeliveries(deliveriesFor(outboxPending(run)), makeCourier(gate, io, 15000))
  expect(settled.get(run)?.[0]).toMatchObject({ ok: false, code: 'agent_not_running', permanent: false })
  expect(gate.failuresFor('w1:p1')).toBe(1)
})

test('a tick whose every pane stalls costs one take-up window, not one per pane — #25', async () => {
  // Fake clock: each stalled send takes herdr's 5s window from when it starts,
  // so the tick's length is the longest chain of sends to any one pane.
  const clock = { now: 0 }
  const panes = Array.from({ length: 8 }, (_, i) => `w${i + 2}:p1`)
  const gate = gateAt(clock)
  gate.beginTick(new Set(panes))
  const io: PromptIO = {
    agentPromptConfirmed: async () => {
      const startedAt = clock.now
      await Bun.sleep(0)
      clock.now = Math.max(clock.now, startedAt + 5000)
      return stalled()
    },
    agentStatus: async () => 'idle',
    agentSendKeys: async () => ({ ok: true }),
    paneRead: async () => claudeScreen(''),
  }
  const run = mkRun()
  const deliveries = panes.map((paneId) => ({ paneId, text: 'x', run, sources: [] }))
  await flushDeliveries(deliveries, makeCourier(gate, io, 15000))
  expect(clock.now).toBe(5000)
})

test('one pane\'s deliveries go in order, never two at once into one box', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w1:p1']))
  let inFlight = 0
  let most = 0
  const io = fakeIO()
  io.agentPromptConfirmed = async () => {
    inFlight += 1
    most = Math.max(most, inFlight)
    await Bun.sleep(1)
    inFlight -= 1
    return { ok: true }
  }
  const run = mkRun()
  const other = mkRun()
  await flushDeliveries([
    { paneId: 'w1:p1', text: 'a', run, sources: [] },
    { paneId: 'w1:p1', text: 'b', run: other, sources: [] },
  ], makeCourier(gate, io, 15000))
  expect(most).toBe(1)
})

test('a tick that has used its time budget admits no more sends', () => {
  const clock = { now: 0 }
  const gate = gateAt(clock, 8, 300_000, 20_000)
  gate.beginTick(new Set(['w1:p1', 'w7:p1']))
  expect(gate.admit('w1:p1')).toBeNull()
  clock.now = 20_000
  expect(gate.admit('w7:p1')).toBe('budget')
  gate.beginTick(new Set(['w1:p1', 'w7:p1']))
  expect(gate.admit('w7:p1')).toBeNull()
})

test('the tick\'s delivery time is counted from its first send, not from the tick\'s start', () => {
  const clock = { now: 0 }
  const gate = gateAt(clock, 8, 300_000, 20_000)
  gate.beginTick(new Set(['w1:p1', 'w7:p1']))
  clock.now = 21_000 // slow gh and advance work before any delivery
  expect(gate.admit('w1:p1')).toBeNull()
  clock.now = 40_000
  expect(gate.admit('w7:p1')).toBeNull()
  clock.now = 41_000
  expect(gate.admit('w7:p1')).toBe('budget')
})

test('a probe the budget keeps deferring is sent past it after PROBE_DEFERRALS_MAX ticks — #32', async () => {
  const gate = gateAt({ now: 0 }, 0)
  const io = fakeIO()
  const sendProbe = boundedProbeSend(makeCourier(gate, io, 15000))
  const outcomes: Array<string | undefined> = []
  for (let tick = 0; tick <= PROBE_DEFERRALS_MAX; tick++) {
    gate.beginTick(new Set(['w7:p1']))
    outcomes.push((await sendProbe('run:t1', 'w7:p1', 'probe')).held)
  }
  expect(outcomes).toEqual([...Array(PROBE_DEFERRALS_MAX).fill('budget'), undefined])
  expect(io.calls.filter((c) => c.startsWith('prompt'))).toHaveLength(1)
})

test('forcing a deferred probe past the budget never forces it onto a gone or backing-off pane', async () => {
  const gate = gateAt({ now: 0 }, 0)
  gate.beginTick(new Set(['w1:p1']))
  const sendProbe = boundedProbeSend(makeCourier(gate, fakeIO(), 15000), 0)
  expect((await sendProbe('run:t1', 'w7:p1', 'probe')).held).toBe('pane_gone')
})

test('a text-level rejection drops only the entry that caused it', async () => {
  const run = mkRun()
  const poison = enqueue(run, { to: 'worker', taskId: 't1', text: 'POISON' }, 0)
  const fine = enqueue(run, { to: 'worker', taskId: 't1', text: 'fine' }, 0)
  const settled = await flushDeliveries(
    deliveriesFor(outboxPending(run)),
    async (_pane, text) => (text.includes('POISON')
      ? { ok: false, code: 'invalid_request' }
      : { ok: true }),
    () => {},
  )
  expect(settled.get(run)).toEqual([
    { id: poison.id, ok: false, code: 'invalid_request', permanent: true },
    { id: fine.id, ok: true, code: undefined, permanent: false },
  ])
})
