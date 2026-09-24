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

/**
 * Presses `ctrl+c` only when all three hold: the agent reads idle (on a working
 * one it interrupts the turn), the screen shows a Claude input box with text in it
 * (on an empty box it arms exit), and the pane's guard grants the press.
 */
async function clearInputBox(io: PromptIO, paneId: string, clears: ClearGuard): Promise<boolean> {
  if (!isAgentReady(await io.agentStatus(paneId))) return false
  const box = inputBoxText(await io.paneRead(paneId, SCREEN_LINES))
  if (box === null || box.length === 0) return false
  if (!clears.claim(paneId)) return false
  return (await io.agentSendKeys(paneId, ['ctrl+c'])).ok
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
 */
export async function sendConfirmed(
  io: PromptIO, paneId: string, text: string, timeoutMs: number, clears: ClearGuard,
): Promise<CallResult<unknown>> {
  const sent = await io.agentPromptConfirmed(paneId, text, timeoutMs)
  if (sent.ok || !MAY_HAVE_LANDED.has(sent.code ?? '')) return sent

  const status = await io.agentStatus(paneId)
  if (status === 'working' || status === 'blocked') return { ok: true }
  await clearInputBox(io, paneId, clears)
  return sent
}

export type HoldReason = 'pane_gone' | 'backoff' | 'budget'

export interface SendOutcome {
  ok: boolean
  code?: string
  /** Set when nothing was sent: the pane is known not to answer, or the tick's budget is spent. */
  held?: HoldReason
}

export type Send = (paneId: string, text: string) => Promise<SendOutcome>

/** The first retry waits past herdr's own 5s take-up window. */
export const BACKOFF_BASE_MS = 5_000

export interface GateConfig {
  /** Sends of every kind per tick — digests, answers, decisions and probes share it. */
  sendsPerTick: number
  backoffMaxMs: number
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
  private livePanes: ReadonlySet<string> = new Set()
  private sentThisTick = 0
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

  holdFor(paneId: string): HoldReason | null {
    if (this.livePanes.size > 0 && !this.livePanes.has(paneId)) {
      if (!this.reportedGone.has(paneId)) {
        this.reportedGone.add(paneId)
        this.log(`pane ${paneId} is gone; holding what is addressed to it — \`hpipe status\` lists it`)
      }
      return 'pane_gone'
    }
    const health = this.health.get(paneId)
    if (health && this.now() < health.nextAttemptAt) return 'backoff'
    if (this.sentThisTick >= this.config.sendsPerTick) {
      if (!this.budgetReported) {
        this.budgetReported = true
        this.log(`delivery budget of ${this.config.sendsPerTick} sends spent this tick; the rest wait`)
      }
      return 'budget'
    }
    return null
  }

  /**
   * Only a retryable code counts against the pane. Any other code is about the
   * text, not the recipient, and backing the pane off for it would hold every
   * other prompt addressed there.
   */
  record(paneId: string, result: { ok: boolean; code?: string }): void {
    this.sentThisTick += 1
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

export function makeCourier(
  gate: DeliveryGate, io: PromptIO, confirmMs: number, clears: ClearGuard = new ClearGuard(),
): Send {
  return async (paneId, text) => {
    const held = gate.holdFor(paneId)
    if (held !== null) return { ok: false, code: held, held }
    const result = await sendConfirmed(io, paneId, text, confirmMs, clears)
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
 */
export async function flushDeliveries(
  deliveries: readonly Delivery[], send: Send, log: (message: string) => void = warnToTick,
): Promise<Map<Run, Settlement[]>> {
  const settled = new Map<Run, Settlement[]>()
  for (const delivery of deliveries) {
    const outcome = await send(delivery.paneId, delivery.text)
    if (outcome.held !== undefined) continue

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
  return settled
}
