import type { PaneHold } from '../lib/delivery-health'
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
  paneReadStyled(target: string, lines: number): Promise<string>
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

const PLAIN_RULE = /^─{10,}$/
/**
 * A session named with `/rename` carries its name in the box's TOP rule —
 * `──── PR#132 review ─`, truncated with `…` in a narrow pane — leaving as few as
 * two dashes before it. Only ever accepted as the top rule of a box whose first
 * line is `❯` and whose bottom rule is plain: transcript text can start with
 * `── ` too.
 */
const LABELLED_TOP_RULE = /^─{2,} \S.*$/
const SCREEN_LINES = 40

/**
 * The text in a Claude input box — the `❯` line and any continuation lines between
 * the two horizontal rules that frame it — or `null` when the screen shows no box
 * this recognises, which callers must read as "do not touch". The last framed box
 * wins; Claude's rewind menu also draws `❯`, but indented and unframed.
 */
export function inputBoxText(screen: string): string | null {
  const lines = screen.split('\n')
  const isTopRule = (line: string) => PLAIN_RULE.test(line) || LABELLED_TOP_RULE.test(line)
  for (let close = lines.length - 1; close > 0; close--) {
    if (!PLAIN_RULE.test((lines[close] ?? '').trim())) continue
    let open = close - 1
    while (open >= 0 && !isTopRule((lines[open] ?? '').trim())) open--
    if (open < 0) return null
    const box = lines.slice(open + 1, close)
    if (!(box[0] ?? '').startsWith('❯')) continue
    return box.map((line, i) => (i === 0 ? line.slice(1) : line)).join('\n').trim()
  }
  return null
}

const TERMINAL_ESCAPE = /\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** SGR parameters after which a colour index or RGB triple follows, not a style. */
const EXTENDED_COLOUR = new Set([38, 48, 58])

function faintAfter(params: string, faint: boolean): boolean {
  const codes = params === '' ? [0] : params.split(';').map(Number)
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code !== undefined && EXTENDED_COLOUR.has(code)) {
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 1
    } else if (code === 0 || code === 22) {
      faint = false
    } else if (code === 2) {
      faint = true
    }
  }
  return faint
}

/**
 * The screen as text, minus everything drawn faint. Claude draws its prompt
 * suggestion inside the input box in faint text, and a plain-text read cannot
 * tell it from a human's draft — every idle box would read as stuck. Measured
 * against Claude Code in a live herdr 0.9.0 session.
 */
export function withoutFaintText(styled: string): string {
  let faint = false
  let text = ''
  let from = 0
  const visible = (segment: string) => (faint ? keptWhenFaint(segment) : segment)
  for (const escape of styled.matchAll(TERMINAL_ESCAPE)) {
    text += visible(styled.slice(from, escape.index))
    from = escape.index + escape[0].length
    if (escape[2] === 'm') faint = faintAfter(escape[1] ?? '', faint)
  }
  text += visible(styled.slice(from))
  return text.replace(/\r/g, '')
}

/**
 * A paste placeholder is someone's input whatever it is drawn in: dropped with
 * the suggestion, a stuck paste would read as an empty box and the next send
 * would be appended to it.
 */
function keptWhenFaint(segment: string): string {
  return (segment.match(PASTE_PLACEHOLDER) ?? []).join(' ')
}

async function readInputBox(io: PromptIO, paneId: string): Promise<string | null> {
  return inputBoxText(withoutFaintText(await io.paneReadStyled(paneId, SCREEN_LINES)))
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
 * a long supervisor send collapses to exactly that. So it is only ever asked
 * about a send the gate saw stall on that pane and still believes is in the box
 * (see `stalledSendTo`) — never about a box merely found before a send. A human pasting into an idle
 * WORKER's box between that stall and the clear is the one case that would clear
 * their paste; the orchestrator pane, where humans type, is never cleared at all.
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

/** `empty`: the box was read and holds nothing, so no stalled send of ours is left in it. */
type BoxOutcome = 'cleared' | 'empty' | 'stuck' | 'untouched'

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
  const box = await readInputBox(io, paneId)
  if (box === null) return 'untouched'
  if (box.length === 0) return 'empty'
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
): Promise<CallResult<unknown> & { boxClear?: true }> {
  const sent = await io.agentPromptConfirmed(paneId, text, timeoutMs)
  if (sent.ok || !MAY_HAVE_LANDED.has(sent.code ?? '')) return sent

  const status = await io.agentStatus(paneId)
  if (status === 'working' || status === 'blocked') return { ok: true }
  const box = await clearInputBox(io, paneId, text, clears, humanTypesIn)
  if (box === 'stuck') {
    return { ok: false, code: STUCK_INPUT, message: `input box of ${paneId} holds text the supervisor did not send` }
  }
  return box === 'cleared' || box === 'empty' ? { ...sent, boxClear: true } : sent
}

export type HoldReason = 'pane_gone' | 'backoff' | 'budget' | typeof STUCK_INPUT

export interface SendOutcome {
  ok: boolean
  code?: string
  /** Set when nothing was sent: the pane is known not to answer, or the tick's budget is spent. */
  held?: HoldReason
}

export interface SendOptions {
  overBudget?: boolean
  /** Delivered only once the box no longer holds the text; see `submittedWithin`. */
  awaitSubmission?: boolean
}

export type Send = (paneId: string, text: string, options?: SendOptions) => Promise<SendOutcome>

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

/** How long a stalled send's text is treated as possibly still ours in the box. */
export const STALLED_SEND_TTL_MS = 60_000

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
  since: number
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
  /** Pane → when its box was first found holding text the supervisor did not write. */
  private readonly stuck = new Map<string, number>()
  private readonly boxReadThisTick = new Set<string>()
  /** The last send seen to stall on each pane and left in its box, and when. */
  private readonly stalledSends = new Map<string, { text: string; at: number }>()
  private livePanes: ReadonlySet<string> = new Set()
  private sentThisTick = 0
  private firstSendAt: number | null = null
  private budgetReported = false
  /** Bumped whenever `holds()` would read differently, so the supervisor rewrites it only then. */
  revision = 0

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
    this.boxReadThisTick.clear()
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

  /** A pane whose input box was last seen holding text the supervisor did not write. */
  isStuck(paneId: string): boolean {
    return this.stuck.has(paneId)
  }

  markStuck(paneId: string): void {
    if (this.stuck.has(paneId)) return
    this.stuck.set(paneId, this.now())
    this.revision += 1
    this.log(`stuck input in ${paneId}: its input box holds text the supervisor did not send, ` +
      'so nothing more is sent there until it is submitted or cleared — `hpipe status` lists it')
  }

  unstick(paneId: string): void {
    if (!this.stuck.delete(paneId)) return
    this.revision += 1
    this.log(`input box of ${paneId} is clear again; delivering to it`)
  }

  noteStalled(paneId: string, text: string): void {
    this.stalledSends.set(paneId, { text, at: this.now() })
  }

  /** The box no longer holds it: cleared, submitted or seen empty. */
  forgetStalled(paneId: string): void {
    this.stalledSends.delete(paneId)
  }

  /**
   * What may be sitting in the pane's box because the supervisor put it there.
   * Past STALLED_SEND_TTL_MS a box that still matches is more likely a human's
   * later paste — a bare placeholder matches any long send — than our leftover.
   */
  stalledSendTo(paneId: string): string | undefined {
    const stalled = this.stalledSends.get(paneId)
    if (stalled === undefined) return undefined
    if (this.now() - stalled.at <= STALLED_SEND_TTL_MS) return stalled.text
    this.stalledSends.delete(paneId)
    return undefined
  }

  /**
   * Whether this pane's box was already read this tick. A stuck box is read once
   * per tick, not once per prompt owed to it, while a human's draft sits there.
   */
  boxReadAlready(paneId: string): boolean {
    if (this.boxReadThisTick.has(paneId)) return true
    this.boxReadThisTick.add(paneId)
    return false
  }

  /**
   * Only a retryable code counts against the pane. Any other code is about the
   * text, not the recipient, and backing the pane off for it would hold every
   * other prompt addressed there.
   */
  record(paneId: string, result: { ok: boolean; code?: string }): void {
    if (result.code === STUCK_INPUT) this.markStuck(paneId)
    const health = this.health.get(paneId)
    if (result.ok) {
      this.stalledSends.delete(paneId)
      if (health) {
        this.health.delete(paneId)
        this.revision += 1
        this.log(`delivery to ${paneId} recovered after ${health.failures} failed attempt(s)`)
      }
      return
    }
    const code = result.code ?? 'unknown'
    if (!isRetryable(code)) return

    const failures = (health?.failures ?? 0) + 1
    const delay = Math.min(this.config.backoffMaxMs, BACKOFF_BASE_MS * 2 ** (failures - 1))
    const now = this.now()
    this.health.set(paneId, {
      failures, nextAttemptAt: now + delay, lastCode: code, since: health?.since ?? now,
    })
    this.revision += 1
    if (failures === 1) {
      this.log(`delivery to ${paneId} failed (${code}); retrying with backoff, what is owed stays queued`)
    }
  }

  failuresFor(paneId: string): number {
    return this.health.get(paneId)?.failures ?? 0
  }

  /** Every pane the gate is holding sends for, and why — what `hpipe status` reads. */
  holds(): Record<string, PaneHold> {
    const out: Record<string, PaneHold> = {}
    for (const [pane, health] of this.health) {
      out[pane] = { since: health.since, failures: health.failures, code: health.lastCode }
    }
    for (const [pane, since] of this.stuck) {
      const failing = out[pane]
      out[pane] = {
        since: Math.min(since, failing?.since ?? since), failures: failing?.failures ?? 0, code: STUCK_INPUT,
      }
    }
    return out
  }
}

export interface CourierOptions {
  clears?: ClearGuard
  /** Panes a human types in — every orchestrator pane — whose input box is never cleared. */
  humanTypesIn?: (paneId: string) => boolean
  sleep?: (ms: number) => Promise<void>
}

const SUBMIT_POLL_MS = 500

/**
 * herdr's `--until working` can confirm while Claude still holds a long paste
 * unsubmitted in its box: an answer read `working` at once and sat there as
 * `[Pasted text #3 +11 lines]` for several seconds more. Measured on a live run.
 * So a send whose delivery moves state waits, up to `timeoutMs`, for the box to
 * stop holding nothing but this send. A box someone else has typed into since is
 * not ours to wait on.
 */
async function submittedWithin(
  io: PromptIO, paneId: string, text: string, timeoutMs: number, sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let waited = 0; ; waited += SUBMIT_POLL_MS) {
    const box = await readInputBox(io, paneId)
    if (box === null || box.length === 0 || !boxHoldsOnly(box, text)) return true
    if (waited >= timeoutMs) return false
    await sleep(SUBMIT_POLL_MS)
  }
}

export function makeCourier(
  gate: DeliveryGate, io: PromptIO, confirmMs: number, options: CourierOptions = {},
): Send {
  const clears = options.clears ?? new ClearGuard()
  const humanTypesIn = options.humanTypesIn ?? (() => false)
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const heldStuck: SendOutcome = { ok: false, code: STUCK_INPUT, held: STUCK_INPUT }
  return async (paneId, text, sendOptions = {}) => {
    if (gate.isStuck(paneId) && gate.boxReadAlready(paneId)) return heldStuck
    const held = gate.admit(paneId, sendOptions.overBudget === true)
    if (held !== null) return { ok: false, code: held, held }
    const boxHeld = await boxHold(io, gate, paneId, text, clears, humanTypesIn(paneId))
    if (boxHeld !== null) return boxHeld
    let result = await sendConfirmed(io, paneId, text, confirmMs, clears, humanTypesIn(paneId))
    if (result.ok && sendOptions.awaitSubmission === true &&
      !(await submittedWithin(io, paneId, text, confirmMs, sleep))) {
      // Left to the stall path, so the next attempt clears it before re-sending.
      result = {
        ok: false, code: 'agent_prompt_stalled',
        message: `${paneId} read as taking the prompt up, but its input box still holds it`,
      }
    }
    if (result.boxClear === true) gate.forgetStalled(paneId)
    else if (!result.ok && MAY_HAVE_LANDED.has(result.code ?? '')) gate.noteStalled(paneId, text)
    gate.record(paneId, result)
    return result.ok ? { ok: true } : { ok: false, code: result.code ?? 'unknown' }
  }
}

/**
 * Read before EVERY send, not only after a stalled one: herdr's `agent prompt`
 * does not clear the box, and a send into a box holding a human's draft is
 * submitted with the draft first and does not stall. Both a worker and the
 * orchestrator then read the whole message as the draft and ignored the prompt.
 * Measured on a live run.
 *
 * Only text an earlier send left there is ever cleared: the gate must have seen a
 * send to this pane stall within STALLED_SEND_TTL_MS, with no confirmed delivery,
 * clear or empty box since, and the box must hold nothing but that send. A box holding only a paste placeholder matches
 * any long send, so without the stall it is a human's paste and holds the send.
 * The clear is `clearInputBox`'s, or the send waits for a tick that can make it.
 */
async function boxHold(
  io: PromptIO, gate: DeliveryGate, paneId: string, text: string, clears: ClearGuard,
  humanTypesIn: boolean,
): Promise<SendOutcome | null> {
  gate.boxReadAlready(paneId)
  const box = await readInputBox(io, paneId)
  if (box === null || box.length === 0) {
    if (box !== null) gate.forgetStalled(paneId)
    gate.unstick(paneId)
    return null
  }
  const stalled = gate.stalledSendTo(paneId)
  if (humanTypesIn || stalled === undefined || !boxHoldsOnly(box, stalled)) {
    gate.markStuck(paneId)
    return { ok: false, code: STUCK_INPUT, held: STUCK_INPUT }
  }
  const outcome = await clearInputBox(io, paneId, stalled, clears, false)
  if (outcome !== 'cleared' && outcome !== 'empty') {
    return { ok: false, code: 'backoff', held: 'backoff' }
  }
  gate.forgetStalled(paneId)
  return null
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
 * Runs whose orchestrator missed a digest. Event lines are kept nowhere, so one
 * that is not delivered is lost, and the orchestrator of the smoke run's dead
 * window came back to a decision prompt and none of the transitions before it.
 * Measured on a live run. A run owed one gets a catch-up with every digest to it
 * until one lands — whether on the pane that failed or on one claimed since.
 * Held in memory: a restarted supervisor owes none.
 */
export class CatchUps {
  private readonly owed = new Set<string>()

  note(delivery: Delivery, delivered: boolean): void {
    if (delivery.paneId !== delivery.run.orchestrator_pane) return
    if (delivered) this.owed.delete(delivery.run.run_id)
    else this.owed.add(delivery.run.run_id)
  }

  pendingFor(run: Run, render: (run: Run) => string): PendingPrompt[] {
    if (!this.owed.has(run.run_id) || run.orchestrator_pane === null) return []
    if (runRow(run.phase).terminal === true) {
      this.owed.delete(run.run_id)
      return []
    }
    return [{
      paneId: run.orchestrator_pane, run, text: render(run), events: [], isOrchestrator: true,
      phaseNote: ' — catch-up',
    }]
  }
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
  onEphemeral: (delivery: Delivery, delivered: boolean) => void = () => {},
): Promise<Map<Run, Settlement[]>> {
  const byPane = new Map<string, Delivery[]>()
  for (const delivery of deliveries) {
    byPane.set(delivery.paneId, [...(byPane.get(delivery.paneId) ?? []), delivery])
  }

  const settled = new Map<Run, Settlement[]>()
  const settle = (delivery: Delivery, outcome: SendOutcome) => {
    if (delivery.ephemeral === true) onEphemeral(delivery, outcome.ok)
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
