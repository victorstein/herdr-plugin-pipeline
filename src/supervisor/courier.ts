import type { CallResult } from '../lib/herdr'
import { isAgentReady } from '../lib/machine'
import { enqueue, isCurrent, recipientPane, type Settlement } from '../lib/outbox'
import { runRow } from '../lib/phases'
import type { AgentStatus, QueuedEvent, Run } from '../lib/types'
import { type Delivery, isRetryable, type PendingPrompt, warnToTick } from './deliver'

export interface PromptIO {
  agentPromptConfirmed(target: string, text: string, timeoutMs: number): Promise<CallResult<unknown>>
  agentStatus(target: string): Promise<AgentStatus>
  agentSendKeys(target: string, keys: string[]): Promise<CallResult<unknown>>
  paneRead(target: string, lines: number): Promise<string>
}

/** The two codes herdr returns after it has already written the text and the Enter. */
const MAY_HAVE_LANDED: ReadonlySet<string> = new Set(['agent_prompt_stalled', 'timeout'])

/**
 * A second `ctrl+c` inside Claude's "press again to exit" window quits the agent,
 * and that window measured under 2s. Five times that, so no clock jitter or slow
 * herdr call can bring two presses inside it.
 */
export const CLEAR_MIN_INTERVAL_MS = 10_000

/**
 * The one place a supervisor `ctrl+c` is allowed through: at most one per pane per
 * CLEAR_MIN_INTERVAL_MS, whatever the delivery backoff says. Held in memory only —
 * a restarted supervisor cannot press within the window of its predecessor's
 * press, because its first clear follows a send herdr spends 5s declaring stalled.
 */
export class ClearGuard {
  private readonly lastPressAt = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Claims the pane's next press, or refuses it; a refused claim records nothing. */
  claim(paneId: string): boolean {
    const last = this.lastPressAt.get(paneId)
    const now = this.now()
    if (last !== undefined && now - last < CLEAR_MIN_INTERVAL_MS) return false
    this.lastPressAt.set(paneId, now)
    return true
  }
}

const INPUT_BOX_RULE = /^─{10,}$/
const SCREEN_LINES = 40

/**
 * The text in a Claude input box — the `❯` line and any continuation lines between
 * the two horizontal rules that frame it — or `null` when the screen shows no box
 * this recognises, which callers must read as "do not touch". The last framed box
 * wins; Claude's rewind menu also draws `❯`, but indented and unframed.
 */
export function inputBoxText(screen: string): string | null {
  const lines = screen.split('\n')
  for (let close = lines.length - 1; close > 0; close--) {
    if (!INPUT_BOX_RULE.test((lines[close] ?? '').trim())) continue
    let open = close - 1
    while (open >= 0 && !INPUT_BOX_RULE.test((lines[open] ?? '').trim())) open--
    if (open < 0) return null
    const box = lines.slice(open + 1, close)
    if (!(box[0] ?? '').startsWith('❯')) continue
    return box.map((line, i) => (i === 0 ? line.slice(1) : line)).join('\n').trim()
  }
  return null
}

/** How a long paste collapses in a Claude input box, measured live: `[Pasted text #1 +40 lines]`. */
const PASTE_PLACEHOLDER = /\[Pasted text #\d+[^\]]*\]/g
const squashSpace = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Whether every line of the box could only have come from this send: a paste
 * placeholder, or a piece of the exact text sent — a piece, because the box
 * soft-wraps and #18 measured a send arriving as a fragment of its tail. A line
 * that is neither is someone else's typing, and the box is not ours to clear.
 *
 * The residual: a box holding nothing but a placeholder is read as ours, because
 * a long supervisor send collapses to exactly that. A human pasting into an idle
 * WORKER's box at the moment the supervisor's send stalls is the one case that
 * would clear their paste; the orchestrator pane, where humans type, is never
 * cleared at all.
 */
export function boxHoldsOnly(box: string, sent: string): boolean {
  const ours = squashSpace(sent)
  return box.split('\n').every((line) => {
    const rest = squashSpace(line.replace(PASTE_PLACEHOLDER, ' '))
    return rest.length === 0 || (rest.length >= MIN_PIECE_CHARS && ours.includes(rest))
  })
}

/**
 * A shorter line is not read as a piece of the send even when it is one: #18's
 * stray `merge it` is a substring of the merge prompt, and a human's short draft
 * matching by chance must be reported stuck, not cleared. The cost is that a very
 * short tail fragment of our own is reported stuck too, which is the safe side.
 */
const MIN_PIECE_CHARS = 16

/** Text the supervisor did not write is sitting in the pane's input box. */
export const STUCK_INPUT = 'stuck_input'

type BoxOutcome = 'cleared' | 'stuck' | 'untouched'

/**
 * Presses `ctrl+c` only when every one of these holds, and says `stuck` when the
 * box holds text it must not touch:
 * - the pane is not one a human types in (the orchestrator's never is cleared);
 * - the agent reads idle — on a working one `ctrl+c` interrupts the turn — read
 *   again immediately before the press, so a human's Enter in between is caught;
 * - the screen shows a Claude input box, and it is not empty: on an empty box
 *   `ctrl+c` arms Claude's exit;
 * - everything in the box is this send's own text (`boxHoldsOnly`);
 * - the pane's `ClearGuard` grants the press.
 */
async function clearInputBox(
  io: PromptIO, paneId: string, sent: string, clears: ClearGuard, humanTypesIn: boolean,
): Promise<BoxOutcome> {
  if (!isAgentReady(await io.agentStatus(paneId))) return 'untouched'
  const box = inputBoxText(await io.paneRead(paneId, SCREEN_LINES))
  if (box === null || box.length === 0) return 'untouched'
  if (humanTypesIn || !boxHoldsOnly(box, sent)) return 'stuck'
  if (!clears.claim(paneId)) return 'untouched'
  if (!isAgentReady(await io.agentStatus(paneId))) return 'untouched'
  return (await io.agentSendKeys(paneId, ['ctrl+c'])).ok ? 'cleared' : 'untouched'
}

/**
 * Delivered means herdr saw the agent take the prompt up, not that the bytes were
 * written: a brief on the berean-os run sat unsubmitted in the input box with every
 * call reporting success. A send that was written but never taken up is resolved
 * here rather than left for the next attempt, because herdr's `agent prompt` does
 * not clear the box first — text left in it is prepended to whatever is sent next
 * and submitted with it.
 *
 * `ctrl+c` is the only single key that empties a Claude input box whole: `ctrl+u`
 * deletes one line of a multi-line box, and `esc esc` on an empty box opens
 * Claude's rewind menu. Measured against Claude Code in a live herdr 0.9.0 session.
 *
 * The prompt is re-sent whole rather than submitted with a bare Enter: a send can
 * arrive as a fragment of its tail (#18), and submitting a fragment executes it.
 *
 * A stall is therefore resolved as not delivered unless the agent is seen working,
 * and that costs at most ONE duplicate per stall: a Claude that submitted late but
 * has not yet flipped to working reads idle with an empty box, nothing is pressed,
 * and the next confirmed send repeats the prompt. Phase prompts are fixed text
 * with their verdict path already reserved, so the agent reading one twice is
 * harmless; a stall that leaves the box empty must not be read as "never arrived".
 */
export async function sendConfirmed(
  io: PromptIO, paneId: string, text: string, timeoutMs: number, clears: ClearGuard,
  humanTypesIn = false,
): Promise<CallResult<unknown>> {
  const sent = await io.agentPromptConfirmed(paneId, text, timeoutMs)
  if (sent.ok || !MAY_HAVE_LANDED.has(sent.code ?? '')) return sent

  const status = await io.agentStatus(paneId)
  if (status === 'working' || status === 'blocked') return { ok: true }
  if (await clearInputBox(io, paneId, text, clears, humanTypesIn) === 'stuck') {
    return { ok: false, code: STUCK_INPUT, message: `input box of ${paneId} holds text the supervisor did not send` }
  }
  return sent
}

export type HoldReason = 'pane_gone' | 'backoff' | 'budget' | typeof STUCK_INPUT

export interface SendOutcome {
  ok: boolean
  code?: string
  /** Set when nothing was sent: the pane is known not to answer, or the tick's budget is spent. */
  held?: HoldReason
}

export type Send = (
  paneId: string, text: string, options?: { overBudget?: boolean },
) => Promise<SendOutcome>

/**
 * Consecutive ticks a stall probe may be deferred by the tick's budget before it
 * is sent past it. A deferral records nothing on the ladder, so without a bound a
 * supervisor whose budget is spent every tick would never probe or escalate —
 * #32's silence again.
 */
export const PROBE_DEFERRALS_MAX = 5

/**
 * Wraps a probe send so a probe deferred PROBE_DEFERRALS_MAX ticks in a row is
 * then sent regardless of the budget. Keyed by the record probed; any outcome
 * other than a budget deferral resets its count.
 */
export function boundedProbeSend(send: Send, maxDeferrals = PROBE_DEFERRALS_MAX) {
  const deferrals = new Map<string, number>()
  return async (key: string, paneId: string, text: string): Promise<SendOutcome> => {
    const overBudget = (deferrals.get(key) ?? 0) >= maxDeferrals
    const outcome = await send(paneId, text, { overBudget })
    if (outcome.held === 'budget') deferrals.set(key, (deferrals.get(key) ?? 0) + 1)
    else deferrals.delete(key)
    return outcome
  }
}

/** The first retry waits past herdr's own 5s take-up window. */
export const BACKOFF_BASE_MS = 5_000

export interface GateConfig {
  /** Sends of every kind per tick — digests, answers, decisions and probes share it. */
  sendsPerTick: number
  backoffMaxMs: number
  /**
   * Wall time, counted from the tick's FIRST send, after which it admits no more.
   * A stalled confirmed send costs herdr's 5s take-up window, and eight of them in
   * series would hold one tick for 40s, reading every later run against idle
   * states that old. Counted from the first send, not the tick's start: slow gh
   * calls before any delivery would otherwise spend it every tick, and nothing
   * would ever be delivered.
   */
  tickBudgetMs: number
}

interface PaneHealth {
  failures: number
  nextAttemptAt: number
  lastCode: string
}

/**
 * Decides whether a send may be attempted at all. Every send path goes through
 * one gate so the bound it promises holds however many things are wrong at once.
 * The berean-os orchestrator died of a usage limit and was prompted 33 more times
 * over 13 hours, measured on a live run; #15's first ladder design, probing on
 * every 1s tick, would have made that ~46,800.
 *
 * It holds sends, never state: a held prompt stays in the outbox and a held probe
 * still climbs the stall ladder, so a pane that cannot answer pauses only what is
 * addressed to it, never the run.
 */
export class DeliveryGate {
  private readonly health = new Map<string, PaneHealth>()
  private readonly reportedGone = new Set<string>()
  private readonly stuck = new Set<string>()
  private livePanes: ReadonlySet<string> = new Set()
  private sentThisTick = 0
  private firstSendAt: number | null = null
  private budgetReported = false

  constructor(
    private readonly config: GateConfig,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = warnToTick,
  ) {}

  /**
   * `livePanes` is herdr's global pane list. An empty one is a failed `pane list`,
   * not a session with no panes — the supervisor's own pane is always in it — so
   * it must not read as every pane being gone.
   */
  beginTick(livePanes: ReadonlySet<string>): void {
    this.livePanes = livePanes
    this.sentThisTick = 0
    this.firstSendAt = null
    this.budgetReported = false
    for (const pane of this.reportedGone) {
      if (livePanes.has(pane)) {
        this.reportedGone.delete(pane)
        this.log(`pane ${pane} is back; delivering what was held for it`)
      }
    }
  }

  /** A pane that reports itself ready again is tried at once rather than at the end of its backoff. */
  wake(paneId: string): void {
    const health = this.health.get(paneId)
    if (health) health.nextAttemptAt = 0
  }

  /**
   * Admits one send to the pane, taking its slot from the tick's budget at once so
   * sends to several panes in flight together cannot overspend it — or says why not.
   * `overBudget` skips only the tick's budget, never a gone, backing-off pane.
   */
  admit(paneId: string, overBudget = false): HoldReason | null {
    if (this.livePanes.size > 0 && !this.livePanes.has(paneId)) {
      if (!this.reportedGone.has(paneId)) {
        this.reportedGone.add(paneId)
        this.log(`pane ${paneId} is gone; holding what is addressed to it — \`hpipe status\` lists it`)
      }
      return 'pane_gone'
    }
    const health = this.health.get(paneId)
    if (health && this.now() < health.nextAttemptAt) return 'backoff'
    const outOfTime = this.firstSendAt !== null &&
      this.now() - this.firstSendAt >= this.config.tickBudgetMs
    if (!overBudget && (this.sentThisTick >= this.config.sendsPerTick || outOfTime)) {
      if (!this.budgetReported) {
        this.budgetReported = true
        this.log(outOfTime
          ? `delivery spent ${this.config.tickBudgetMs}ms this tick; the rest wait`
          : `delivery budget of ${this.config.sendsPerTick} sends spent this tick; the rest wait`)
      }
      return 'budget'
    }
    this.sentThisTick += 1
    this.firstSendAt ??= this.now()
    return null
  }

  /** A pane whose last send found text it did not write in the input box. */
  isStuck(paneId: string): boolean {
    return this.stuck.has(paneId)
  }

  unstick(paneId: string): void {
    if (this.stuck.delete(paneId)) this.log(`input box of ${paneId} is clear again; delivering to it`)
  }

  /**
   * Only a retryable code counts against the pane. Any other code is about the
   * text, not the recipient, and backing the pane off for it would hold every
   * other prompt addressed there.
   */
  record(paneId: string, result: { ok: boolean; code?: string }): void {
    if (result.code === STUCK_INPUT && !this.stuck.has(paneId)) {
      this.stuck.add(paneId)
      this.log(`stuck input in ${paneId}: its input box holds text the supervisor did not send, ` +
        'so nothing more is sent there until it is submitted or cleared — `hpipe status` lists it')
    }
    const health = this.health.get(paneId)
    if (result.ok) {
      if (health) {
        this.health.delete(paneId)
        this.log(`delivery to ${paneId} recovered after ${health.failures} failed attempt(s)`)
      }
      return
    }
    const code = result.code ?? 'unknown'
    if (!isRetryable(code)) return

    const failures = (health?.failures ?? 0) + 1
    const delay = Math.min(this.config.backoffMaxMs, BACKOFF_BASE_MS * 2 ** (failures - 1))
    this.health.set(paneId, { failures, nextAttemptAt: this.now() + delay, lastCode: code })
    if (failures === 1) {
      this.log(`delivery to ${paneId} failed (${code}); retrying with backoff, what is owed stays queued`)
    }
  }

  failuresFor(paneId: string): number {
    return this.health.get(paneId)?.failures ?? 0
  }
}

export interface CourierOptions {
  clears?: ClearGuard
  /** Panes a human types in — every orchestrator pane — whose input box is never cleared. */
  humanTypesIn?: (paneId: string) => boolean
}

export function makeCourier(
  gate: DeliveryGate, io: PromptIO, confirmMs: number, options: CourierOptions = {},
): Send {
  const clears = options.clears ?? new ClearGuard()
  const humanTypesIn = options.humanTypesIn ?? (() => false)
  return async (paneId, text, sendOptions = {}) => {
    // Another send into a box holding someone else's text would be appended to it
    // and submitted with it, so a stuck pane gets nothing until the box is empty.
    if (gate.isStuck(paneId)) {
      const box = inputBoxText(await io.paneRead(paneId, SCREEN_LINES))
      if (box !== null && box.length > 0) return { ok: false, code: STUCK_INPUT, held: STUCK_INPUT }
      gate.unstick(paneId)
    }
    const held = gate.admit(paneId, sendOptions.overBudget === true)
    if (held !== null) return { ok: false, code: held, held }
    const result = await sendConfirmed(io, paneId, text, confirmMs, clears, humanTypesIn(paneId))
    gate.record(paneId, result)
    return result.ok ? { ok: true } : { ok: false, code: result.code ?? 'unknown' }
  }
}

/** Panes whose agent has just reported in: an answer is worth trying now, not at the end of a backoff. */
export function readyPanes(events: readonly QueuedEvent[]): string[] {
  return events
    .filter((e) => e.kind === 'pane.agent_detected' ||
      (e.kind === 'pane.agent_status_changed' && e.agent_status !== undefined &&
        isAgentReady(e.agent_status)))
    .flatMap((e) => (e.pane_id === undefined ? [] : [e.pane_id]))
}

/**
 * Writes every prompt with a body into the outbox, and returns what is left to
 * send only this tick: event lines, which describe a moment and are rebuilt from
 * the ledger on the next wake rather than replayed stale.
 */
export function queuePending(run: Run, pending: readonly PendingPrompt[], now: number): PendingPrompt[] {
  const ephemeral: PendingPrompt[] = []
  for (const prompt of pending) {
    if (prompt.text.length > 0) {
      enqueue(run, {
        to: prompt.isOrchestrator ? 'orchestrator' : 'worker',
        taskId: prompt.taskId ?? null,
        text: prompt.text,
        phaseNote: prompt.phaseNote,
      }, now)
    }
    if (prompt.events.length > 0) ephemeral.push({ ...prompt, text: '' })
  }
  return ephemeral
}

/**
 * The outbox as this tick's pending prompts. A finished run is not delivered for;
 * an `escalated` one is, since the escalation is exactly what it still owes.
 */
export function outboxPending(run: Run, footer?: string): PendingPrompt[] {
  if (runRow(run.phase).terminal === true) return []
  return (run.outbox ?? []).flatMap((entry) => {
    if (!isCurrent(run, entry)) return []
    const paneId = recipientPane(run, entry)
    if (paneId === null) return []
    const isOrchestrator = entry.to === 'orchestrator'
    return [{
      paneId, run, text: entry.text, events: [], isOrchestrator,
      taskId: entry.task_id ?? undefined,
      phaseNote: entry.phase_note,
      footer: isOrchestrator ? footer : undefined,
      outboxId: entry.id,
    }]
  })
}

/**
 * Sends each delivery and reports, per run, what became of the outbox entries in
 * it. A held delivery changes nothing, so it produces no settlement and no save.
 *
 * Panes are independent, so they are sent to concurrently; one pane's deliveries
 * go in order, because two prompts typed into one box at once interleave. A tick
 * with a stalled send on every pane then costs one take-up window, not one each.
 */
export async function flushDeliveries(
  deliveries: readonly Delivery[], send: Send, log: (message: string) => void = warnToTick,
): Promise<Map<Run, Settlement[]>> {
  const byPane = new Map<string, Delivery[]>()
  for (const delivery of deliveries) {
    byPane.set(delivery.paneId, [...(byPane.get(delivery.paneId) ?? []), delivery])
  }

  const settled = new Map<Run, Settlement[]>()
  const settle = (delivery: Delivery, outcome: SendOutcome) => {
    if (outcome.held !== undefined) return
    const permanent = !outcome.ok && !isRetryable(outcome.code ?? 'unknown')
    if (permanent && delivery.sources.length > 0) {
      log(`giving up on ${delivery.sources.length} prompt(s) to ${delivery.paneId}: ` +
        `${outcome.code} — herdr will refuse it however often it is sent`)
    }
    for (const { run, outboxId } of delivery.sources) {
      const list = settled.get(run) ?? []
      list.push({ id: outboxId, ok: outcome.ok, code: outcome.code, permanent })
      settled.set(run, list)
    }
  }

  await Promise.all([...byPane.values()].map(async (queue) => {
    for (const delivery of queue) settle(delivery, await send(delivery.paneId, delivery.text))
  }))
  return settled
}
