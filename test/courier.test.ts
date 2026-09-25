import { expect, test } from 'bun:test'
import type { CallResult } from '../src/lib/herdr'
import { newRun } from '../src/lib/ledger'
import { enqueue } from '../src/lib/outbox'
import type { AgentStatus, QueuedEvent, Run, Task } from '../src/lib/types'
import {
  BACKOFF_BASE_MS, boundedProbeSend, boxHoldsOnly, CatchUps, CLEAR_MIN_INTERVAL_MS, ClearGuard, DeliveryGate,
  flushDeliveries,
  inputBoxText, makeCourier, outboxPending, type PromptIO, queuePending, readyPanes, type Send,
  makeSubmissionCheck, PROBE_DEFERRALS_MAX, sendConfirmed, STALLED_SEND_TTL_MS, STUCK_INPUT,
  submissionOf, withoutFaintText,
} from '../src/supervisor/courier'
import { deliveriesFor, type PendingPrompt } from '../src/supervisor/deliver'

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
  // Unless a test fixes the screen, the box is empty until a send stalls in it.
  let leftInBox = false
  return {
    calls,
    agentPromptConfirmed: async (pane, text) => {
      calls.push(`prompt ${pane} ${text}`)
      const result = opts.prompt ? opts.prompt(pane) : { ok: true }
      if (result.code === 'agent_prompt_stalled') leftInBox = true
      return result
    },
    agentStatus: async (pane) => {
      calls.push(`status ${pane}`)
      return opts.statuses?.shift() ?? opts.status ?? 'idle'
    },
    agentSendKeys: async (pane, keys) => {
      calls.push(`keys ${pane} ${keys.join(' ')}`)
      leftInBox = false
      return { ok: true }
    },
    paneReadStyled: async (pane) => {
      calls.push(`read ${pane}`)
      return opts.screen ?? (leftInBox ? STUCK : claudeScreen(''))
    },
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
    paneReadStyled: async () => STUCK,
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
  let screen = DRAFT
  const io = fakeIO()
  io.paneReadStyled = async (pane) => { io.calls.push(`read ${pane}`); return screen }
  const send = makeCourier(gate, io, 15000)
  const prompts = () => io.calls.filter((c) => c.startsWith('prompt')).length

  gate.beginTick(new Set(['w7:p1']))
  expect(await send('w7:p1', 'a')).toEqual({ ok: false, code: STUCK_INPUT, held: STUCK_INPUT })
  gate.beginTick(new Set(['w7:p1']))
  expect(await send('w7:p1', 'b')).toEqual({ ok: false, code: STUCK_INPUT, held: STUCK_INPUT })
  expect(prompts()).toBe(0)

  screen = claudeScreen('')
  gate.beginTick(new Set(['w7:p1']))
  expect((await send('w7:p1', 'b')).ok).toBe(true)
  expect(prompts()).toBe(1)
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
    paneReadStyled: async () => claudeScreen(''),
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

// ——— the box is read before every send — #92 ———

const HUMAN_DRAFT = claudeScreen('human draft: do not send this yet')

test('a worker box holding a human\'s draft gets no send at all, and nothing is pressed', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w7:p1']))
  const io = fakeIO({ screen: HUMAN_DRAFT })
  const outcome = await makeCourier(gate, io, 15000)('w7:p1', 'stall probe text')
  expect(outcome).toEqual({ ok: false, code: STUCK_INPUT, held: STUCK_INPUT })
  expect(io.calls).toEqual(['read w7:p1'])
  expect(gate.holds()['w7:p1']).toEqual({ since: 0, failures: 0, code: STUCK_INPUT })
})

test('the orchestrator\'s box is never sent into while it holds anything, even this send', async () => {
  for (const box of ['orchestrator draft by human, not for sending', SENT]) {
    const gate = gateAt({ now: 0 })
    gate.beginTick(new Set(['w1:p1']))
    const io = fakeIO({ screen: claudeScreen(box) })
    const send = makeCourier(gate, io, 15000, { humanTypesIn: () => true })
    expect((await send('w1:p1', SENT)).held, box).toBe(STUCK_INPUT)
    expect(io.calls.filter((c) => !c.startsWith('read')), box).toEqual([])
  }
})

test('a worker box left holding a send the gate saw stall there is cleared, then the next send goes in', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w7:p1']))
  let screen = claudeScreen('')
  let prompts = 0
  const io = fakeIO({ statuses: ['unknown', 'unknown'] })
  io.agentPromptConfirmed = async (pane, text) => {
    io.calls.push(`prompt ${pane} ${text}`)
    prompts += 1
    if (prompts > 1) return { ok: true }
    screen = claudeScreen(SENT)
    return stalled()
  }
  io.paneReadStyled = async (pane) => { io.calls.push(`read ${pane}`); return screen }
  io.agentSendKeys = async (pane, keys) => {
    io.calls.push(`keys ${pane} ${keys.join(' ')}`)
    screen = claudeScreen('')
    return { ok: true }
  }
  const send = makeCourier(gate, io, 15000)
  // The agent read as no agent at the stall, so nothing was pressed then.
  expect((await send('w7:p1', SENT)).ok).toBe(false)
  expect(presses(io)).toEqual([])

  gate.wake('w7:p1')
  gate.beginTick(new Set(['w7:p1']))
  expect((await send('w7:p1', 'the next prompt')).ok).toBe(true)
  expect(io.calls.filter((c) => c.startsWith('keys') || c.startsWith('prompt')).slice(1))
    .toEqual(['keys w7:p1 ctrl+c', 'prompt w7:p1 the next prompt'])
})

test('a worker box holding only a paste placeholder, with no stall of ours there, is a human\'s paste: held, never pressed', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w7:p1']))
  const io = fakeIO({ screen: claudeScreen('[Pasted text #1 +40 lines]') })
  const outcome = await makeCourier(gate, io, 15000)('w7:p1', 'a long supervisor prompt')
  expect(outcome.held).toBe(STUCK_INPUT)
  expect(io.calls.filter((c) => c.startsWith('keys') || c.startsWith('prompt'))).toEqual([])
})

test('a confirmed delivery forgets the stall, so the box is not ours to clear after it', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w7:p1']))
  gate.noteStalled('w7:p1', SENT)
  gate.record('w7:p1', { ok: true })
  const io = fakeIO({ screen: claudeScreen(SENT) })
  expect((await makeCourier(gate, io, 15000)('w7:p1', SENT)).held).toBe(STUCK_INPUT)
  expect(presses(io)).toEqual([])
})

test('an empty box, or a screen with no box, costs one read and then the send', async () => {
  for (const screen of [claudeScreen(''), 'plain shell $ ']) {
    const gate = gateAt({ now: 0 })
    gate.beginTick(new Set(['w7:p1']))
    const io = fakeIO({ screen })
    expect((await makeCourier(gate, io, 15000)('w7:p1', 'hi')).ok).toBe(true)
    expect(io.calls).toEqual(['read w7:p1', 'prompt w7:p1 hi'])
  }
})

test('a stuck box is read once a tick, however many prompts are owed to it', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w7:p1']))
  const io = fakeIO({ screen: HUMAN_DRAFT })
  const send = makeCourier(gate, io, 15000)
  for (const text of ['a', 'b', 'c']) expect((await send('w7:p1', text)).held).toBe(STUCK_INPUT)
  expect(io.calls).toEqual(['read w7:p1'])
})

test('the gate reports what it holds per pane, and bumps its revision only on a change', () => {
  const clock = { now: 1000 }
  const gate = gateAt(clock)
  gate.beginTick(new Set(['w1:p1']))
  const start = gate.revision
  gate.record('w1:p1', { ok: false, code: 'agent_not_found' })
  clock.now = 9000
  gate.record('w1:p1', { ok: false, code: 'agent_not_found' })
  expect(gate.holds()).toEqual({ 'w1:p1': { since: 1000, failures: 2, code: 'agent_not_found' } })
  const failing = gate.revision
  expect(failing).toBeGreaterThan(start)
  gate.unstick('w1:p1')
  expect(gate.revision).toBe(failing)
  gate.record('w1:p1', { ok: true })
  expect(gate.holds()).toEqual({})
  expect(gate.revision).toBeGreaterThan(failing)
})

// ——— a catch-up for the digests a dead window lost — #91 ———

const digestTo = (run: Run, paneId = 'w1:p1') =>
  deliveriesFor([{ paneId, run, text: '', events: ['- t1 [spec → spec-review]'], isOrchestrator: true }])

test('only a delivery carrying event lines or unqueued text is ephemeral', () => {
  const run = mkRun()
  enqueue(run, { to: 'worker', taskId: 't1', text: 'b' }, 0)
  expect(deliveriesFor(outboxPending(run)).map((d) => d.ephemeral)).toEqual([false])
  expect(digestTo(run).map((d) => d.ephemeral)).toEqual([true])
})

test('a digest the orchestrator never got is owed back as a catch-up until one lands', async () => {
  const run = mkRun()
  const catchUps = new CatchUps()
  const render = () => 'where it stands'
  expect(catchUps.pendingFor(run, render)).toEqual([])

  await flushDeliveries(digestTo(run), async () => ({ ok: false, code: 'backoff', held: 'backoff' }),
    () => {}, (d, delivered) => catchUps.note(d, delivered))
  const [owed] = catchUps.pendingFor(run, render)
  expect(owed).toMatchObject({ paneId: 'w1:p1', text: 'where it stands', isOrchestrator: true })
  expect(deliveriesFor([owed as PendingPrompt])[0]?.text).toContain('[pipeline] run')

  const sent: string[] = []
  await flushDeliveries(deliveriesFor([owed as PendingPrompt]), async (_pane, text) => {
    sent.push(text)
    return { ok: true }
  }, () => {}, (d, delivered) => catchUps.note(d, delivered))
  expect(sent[0]).toContain('where it stands')
  expect(catchUps.pendingFor(run, render)).toEqual([])
})

test('a catch-up owed goes to the pane a replacement orchestrator claimed', async () => {
  const run = mkRun()
  const catchUps = new CatchUps()
  await flushDeliveries(digestTo(run), async () => ({ ok: false, code: 'pane_gone', held: 'pane_gone' }),
    () => {}, (d, delivered) => catchUps.note(d, delivered))
  run.orchestrator_pane = 'w9:p1'
  expect(catchUps.pendingFor(run, () => 'x')[0]?.paneId).toBe('w9:p1')
})

test('a finished run is owed no catch-up', async () => {
  const run = mkRun()
  const catchUps = new CatchUps()
  await flushDeliveries(digestTo(run), async () => ({ ok: false, code: 'agent_not_found' }),
    () => {}, (d, delivered) => catchUps.note(d, delivered))
  run.phase = 'done'
  expect(catchUps.pendingFor(run, () => 'x')).toEqual([])
})

// ——— Claude's faint prompt suggestion is not text in the box ———

const ESC = '\x1b'
const styledRule = (label = '') =>
  `${ESC}[0m${ESC}[38;2;136;136;136m${'─'.repeat(30)}${label}${ESC}[0m`
/** The shape `pane read --format ansi` gave for an idle Claude showing a suggestion, measured live. */
const SUGGESTING = [
  `  ${ESC}[0m${ESC}[38;2;153;153;153mnew task? ${ESC}[0m${ESC}[38;2;177;185;249m/clear${ESC}[0m`,
  styledRule(' PR#132 review ─'),
  `❯ ${ESC}[0m${ESC}[2mverify the Escape one in t…${ESC}[0m`,
  styledRule(),
  `  ${ESC}[0m${ESC}[38;2;180;190;254m[Opus]${ESC}[0m`,
].join('\r\n')

test('faint text is dropped and every other escape stripped, without mistaking an RGB 2 for faint', () => {
  expect(withoutFaintText(`a${ESC}[2mghost${ESC}[22mb${ESC}[38;2;1;2;3mc${ESC}[0m`)).toBe('abc')
  expect(withoutFaintText(`${ESC}[1;2mghost${ESC}[mtyped\r\n`)).toBe('typed\n')
})

test('a paste placeholder survives even when drawn faint, so a stuck paste never reads as an empty box', () => {
  const screen = [styledRule(), `❯ ${ESC}[2m[Pasted text #1 +40 lines]${ESC}[0m`, styledRule()].join('\r\n')
  expect(inputBoxText(withoutFaintText(screen))).toBe('[Pasted text #1 +40 lines]')
})

test('a named session\'s rule is recognised even when a narrow pane leaves two dashes before the name', () => {
  expect(inputBoxText([`── a very long session na…`, '❯ draft', '─'.repeat(12)].join('\n'))).toBe('draft')
})

test('a box showing only Claude\'s suggestion reads as empty, and a named session\'s box is still found', () => {
  expect(inputBoxText(withoutFaintText(SUGGESTING))).toBe('')
  expect(inputBoxText(SUGGESTING.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '')))
    .toBe('verify the Escape one in t…')
})

test('a suggestion in the box does not hold the send', async () => {
  const gate = gateAt({ now: 0 })
  gate.beginTick(new Set(['w1:p1']))
  const io = fakeIO({ screen: SUGGESTING })
  const send = makeCourier(gate, io, 15000, { humanTypesIn: () => true })
  expect((await send('w1:p1', 'digest')).ok).toBe(true)
})

// ——— the remembered stalled send lives only while it can still be in the box ———

const PASTE_ONLY = claudeScreen('[Pasted text #1 +30 lines]')

/** A worker pane whose box and agent the test drives; ctrl+c empties the box. */
function drivenWorker(clock: { now: number }) {
  const state = { screen: claudeScreen(''), prompt: (): CallResult<unknown> => ({ ok: true }) }
  const io = fakeIO()
  io.agentPromptConfirmed = async (pane, text) => { io.calls.push(`prompt ${pane} ${text}`); return state.prompt() }
  io.paneReadStyled = async (pane) => { io.calls.push(`read ${pane}`); return state.screen }
  io.agentSendKeys = async (pane, keys) => {
    io.calls.push(`keys ${pane} ${keys.join(' ')}`)
    state.screen = claudeScreen('')
    return { ok: true }
  }
  const gate = gateAt(clock)
  const send = makeCourier(gate, io, 15000, { clears: new ClearGuard(() => clock.now) })
  const tick = () => { gate.wake('w7:p1'); gate.beginTick(new Set(['w7:p1'])) }
  return { state, io, gate, send, tick }
}

test('a stall cleared at once, then a non-delivery failure, never lets a later paste be pressed — linger', async () => {
  const clock = { now: 0 }
  const w = drivenWorker(clock)
  w.tick()
  w.state.prompt = () => { w.state.screen = claudeScreen(SENT); return stalled() }
  await w.send('w7:p1', SENT)
  expect(presses(w.io)).toEqual(['keys w7:p1 ctrl+c'])

  clock.now = 60_000
  w.tick()
  w.state.prompt = () => ({ ok: false, code: 'agent_not_ready' })
  await w.send('w7:p1', SENT)

  clock.now = 10 * 60_000
  w.tick()
  w.state.screen = PASTE_ONLY
  expect((await w.send('w7:p1', 'a different long prompt')).held).toBe(STUCK_INPUT)
  expect(presses(w.io)).toEqual(['keys w7:p1 ctrl+c'])
})

test('a clear forgets the stalled send, on the stall itself and before a send', async () => {
  const clock = { now: 0 }
  const w = drivenWorker(clock)
  w.tick()
  w.state.prompt = () => { w.state.screen = claudeScreen(SENT); return stalled() }
  await w.send('w7:p1', SENT)
  expect(w.gate.stalledSendTo('w7:p1')).toBeUndefined()

  clock.now = CLEAR_MIN_INTERVAL_MS
  w.gate.noteStalled('w7:p1', SENT)
  w.state.screen = claudeScreen(SENT)
  w.state.prompt = () => ({ ok: false, code: 'agent_not_ready' })
  w.tick()
  await w.send('w7:p1', 'next')
  expect(presses(w.io)).toHaveLength(2)
  expect(w.gate.stalledSendTo('w7:p1')).toBeUndefined()
})

test('a box read empty before a send forgets the stalled send', async () => {
  const w = drivenWorker({ now: 0 })
  w.gate.noteStalled('w7:p1', SENT)
  w.state.prompt = () => ({ ok: false, code: 'agent_not_ready' })
  w.tick()
  await w.send('w7:p1', 'next')
  expect(w.gate.stalledSendTo('w7:p1')).toBeUndefined()
})

test('a leftover older than STALLED_SEND_TTL_MS is not ours: held, never pressed', async () => {
  const clock = { now: 0 }
  const w = drivenWorker(clock)
  w.gate.noteStalled('w7:p1', SENT)
  w.state.screen = claudeScreen(SENT)
  clock.now = STALLED_SEND_TTL_MS + 1
  w.tick()
  expect((await w.send('w7:p1', 'next')).held).toBe(STUCK_INPUT)
  expect(presses(w.io)).toEqual([])
})

test('a transcript prompt framed by `── ` lines is not read as the box', () => {
  const screen = [
    '─'.repeat(40), '❯ ', '─'.repeat(40),
    '── Findings ──', '❯ /ticket https://example.com/pull/1 please review this', '── Notes',
  ].join('\n')
  expect(inputBoxText(screen)).toBe('')
  expect(inputBoxText(['── Findings ──', '❯ an earlier prompt', '── Notes'].join('\n'))).toBeNull()
})

test('a stall that leaves the box empty arms nothing, so a paste seconds later is held, never pressed — late', async () => {
  const clock = { now: 0 }
  const w = drivenWorker(clock)
  w.tick()
  w.state.prompt = () => stalled()
  await w.send('w7:p1', SENT)
  expect(w.io.calls.filter((c) => c.startsWith('keys') || c.startsWith('prompt'))).toEqual([`prompt w7:p1 ${SENT}`])
  expect(w.gate.stalledSendTo('w7:p1')).toBeUndefined()

  clock.now = 3_000
  w.state.screen = PASTE_ONLY
  clock.now = 6_000
  w.tick()
  w.state.prompt = () => ({ ok: true })
  expect((await w.send('w7:p1', 'a different long prompt')).held).toBe(STUCK_INPUT)
  expect(presses(w.io)).toEqual([])
})

// ——— seeing a sent answer submitted — #117 ———

const HELD_PASTE = claudeScreen('[Pasted text #3 +11 lines]')
const ANSWER = '# Decision answered — resume `spec`\n\n**Q:** which way?\n\n**A:** A\n'

function boxReading(screen: () => string, status: AgentStatus = 'working'): FakeIO {
  const io = fakeIO({ status })
  io.paneReadStyled = async (pane) => { io.calls.push(`read ${pane}`); return screen() }
  return io
}

test('an answer is pending while nothing but its paste is in the box, and submitted once the box empties', async () => {
  const clock = { now: 1_000 }
  const gate = gateAt(clock)
  let screen = HELD_PASTE
  const check = makeSubmissionCheck(gate, boxReading(() => screen), 15_000, () => clock.now)

  expect(await check('w7:p1', ANSWER, 0)).toEqual({ state: 'pending' })
  clock.now = 8_000
  screen = claudeScreen('')
  expect(await check('w7:p1', ANSWER, 0)).toEqual({ state: 'submitted', working: true })
})

test('the confirming read reports whether the agent is working on the answer', async () => {
  const check = makeSubmissionCheck(gateAt({ now: 0 }), boxReading(() => claudeScreen(''), 'idle'), 15_000, () => 0)
  expect(await check('w7:p1', ANSWER, 0)).toEqual({ state: 'submitted', working: false })
})

test('an answer still alone in the box past the confirm window is a stall the next send clears first', async () => {
  const clock = { now: 15_000 }
  const gate = gateAt(clock)
  gate.beginTick(new Set(['w7:p1']))
  const io = boxReading(() => HELD_PASTE)
  const check = makeSubmissionCheck(gate, io, 15_000, () => clock.now)

  expect(await check('w7:p1', ANSWER, 0)).toEqual({ state: 'stalled' })
  expect(gate.stalledSendTo('w7:p1')).toBe(ANSWER)
  expect(gate.failuresFor('w7:p1')).toBe(1)
  expect(presses(io)).toEqual([])
})

test('our paste beside someone else\'s text is neither submitted nor cleared: held as stuck input', async () => {
  const gate = gateAt({ now: 0 })
  const io = boxReading(() => claudeScreen('[Pasted text #3 +11 lines] also check the migration order please'))
  const check = makeSubmissionCheck(gate, io, 15_000, () => 60_000)

  expect(await check('w7:p1', ANSWER, 0)).toEqual({ state: 'stuck' })
  expect(gate.isStuck('w7:p1')).toBe(true)
  expect(presses(io)).toEqual([])
})

test('a failed pane read is not an empty box: pending, then a stall once the window passes', async () => {
  const clock = { now: 1_000 }
  const gate = gateAt(clock)
  const check = makeSubmissionCheck(gate, boxReading(() => ''), 15_000, () => clock.now)

  expect(await check('w7:p1', ANSWER, 0)).toEqual({ state: 'pending' })
  clock.now = 15_000
  expect(await check('w7:p1', ANSWER, 0)).toEqual({ state: 'stalled' })
})

test('submissionOf reads the box the answer was sent into', () => {
  expect(submissionOf(null, ANSWER)).toBe('submitted')
  expect(submissionOf('', ANSWER)).toBe('submitted')
  expect(submissionOf('[Pasted text #3 +11 lines]', ANSWER)).toBe('pending')
  expect(submissionOf('**Q:** which way? **A:** A', ANSWER)).toBe('pending')
  expect(submissionOf('[Pasted text #3 +11 lines] also this', ANSWER)).toBe('stuck')
  expect(submissionOf('also this\n**Q:** which way? **A:** A', ANSWER)).toBe('stuck')
  expect(submissionOf('a draft typed after the answer went in', ANSWER)).toBe('submitted')
})
