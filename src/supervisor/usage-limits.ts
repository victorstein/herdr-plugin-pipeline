import type { PaneHold, PersistedLimits } from '../lib/delivery-health'
import { isAgentReady } from '../lib/machine'
import { SCREEN_LINES } from '../lib/screen'
import type { AgentStatus, QueuedEvent } from '../lib/types'
import { FRESH_SIGHT_TOLERANCE_MS, type LimitLine, limitLineOn, resetAt } from '../lib/usage-limit'
import { warnToTick } from './deliver'

/** The message shows minutes only, so the real reset can come up to 59 s after the minute it names. */
export const LIFT_GRACE_MS = 90_000
/** How often a marked pane is read again, so a limit lifted early (a plan upgrade, `/model`) is seen. */
export const RECHECK_MS = 2 * 60_000
/** A pane read this recently is not read again for a stall candidate. */
export const FRESH_MS = 60_000
/** A limit line read this soon after the pane was seen working, or sent a prompt, was printed since. */
export const ACTIVITY_FRESH_MS = 15 * 60_000

export const USAGE_LIMIT = 'usage_limit'

export interface LimitReading {
  status: AgentStatus
  line: LimitLine | null
  boxSeen: boolean
  autoContinue: boolean
}

export interface PaneLimit {
  line: LimitLine
  /** null: the message could not be dated, so only the pane moving on or a nudge lifts it. */
  resetsAt: number | null
  /** When this supervisor, or the one before it, first saw the line. */
  since: number
  autoContinue: boolean
  release?: 'moved-on' | 'nudge'
}

/**
 * Which panes Claude's usage limit has stopped. A pane is limited from the moment
 * it is marked until the lift step has saved its re-arm and calls `lifted` — never
 * by the clock alone, so nothing sees a pane that is neither limited nor re-armed.
 * The courier, the stall ladder and status all ask here.
 */
export class UsageLimits {
  private readonly marks = new Map<string, PaneLimit>()
  /**
   * A line lifted by time or by nudge is still the last thing on the pane's screen.
   * Read again unchanged it is the same limit, not a new one, until a reading shows
   * the pane moved on.
   */
  private readonly stale = new Map<string, string>()
  private readonly nudgedUnmarked = new Set<string>()
  /** Every reading, conclusive or not, so a pane is re-read on schedule rather than every tick. */
  private readonly readAt = new Map<string, number>()
  /** The pane was last seen working, or took a prompt: a limit line read soon after was printed since. */
  private readonly activeAt = new Map<string, number>()
  revision = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = warnToTick,
    persisted?: PersistedLimits,
    private readonly localZone?: string,
  ) {
    for (const [pane, mark] of Object.entries(persisted?.marks ?? {})) {
      this.marks.set(pane, { line: mark.line, resetsAt: mark.resets_at, since: mark.since, autoContinue: false })
    }
    for (const [pane, text] of Object.entries(persisted?.stale ?? {})) this.stale.set(pane, text)
  }

  isLimited(pane: string): boolean {
    return this.marks.has(pane)
  }

  get(pane: string): PaneLimit | undefined {
    return this.marks.get(pane)
  }

  observe(pane: string, reading: LimitReading): void {
    const now = this.now()
    this.readAt.set(pane, now)
    const ready = isAgentReady(reading.status)
    const movedOn = reading.status === 'working' || (ready && reading.boxSeen && reading.line === null)
    const mark = this.marks.get(pane)

    if (mark === undefined) {
      if (movedOn) {
        this.stale.delete(pane)
        this.nudgedUnmarked.delete(pane)
      }
      if (!ready || reading.line === null) return
      if (this.nudgedUnmarked.delete(pane)) {
        this.stale.set(pane, reading.line.text)
        return
      }
      if (this.stale.get(pane) === reading.line.text) return
      this.stale.delete(pane)
      this.markIfCurrent(pane, reading.line, reading.autoContinue, now)
      return
    }

    if (movedOn) {
      this.release(mark, 'moved-on')
      return
    }
    if (!ready || reading.line === null) return
    if (reading.line.text === mark.line.text) {
      // Seen working and then stopped on the same line again: rejected again, still limited.
      if (mark.release === 'moved-on') delete mark.release
      mark.autoContinue = reading.autoContinue
      return
    }
    if (!this.markIfCurrent(pane, reading.line, reading.autoContinue, now)) this.release(mark, 'moved-on')
  }

  /** Marks the pane unless the line's reset has already passed, which makes it an old line. */
  private markIfCurrent(pane: string, line: LimitLine, autoContinue: boolean, now: number): boolean {
    const active = this.activeAt.get(pane)
    const fresh = active !== undefined && now - active <= ACTIVITY_FRESH_MS
    const resetsAt = resetAt(line, now, this.localZone, fresh ? FRESH_SIGHT_TOLERANCE_MS : undefined)
    if (resetsAt !== null && resetsAt + LIFT_GRACE_MS <= now) return false
    this.marks.set(pane, { line, resetsAt, since: now, autoContinue })
    this.revision += 1
    this.log(`usage limit in ${pane}${resetsAt === null ? ', its reset unreadable' : ` until ${resetText(line)}`}: ` +
      'holding what is addressed to it — `hpipe status` lists it')
    return true
  }

  private release(mark: PaneLimit, why: NonNullable<PaneLimit['release']>): void {
    if (mark.release === undefined) mark.release = why
  }

  /** Panes the lift step owes a lift: released, or past their reset and the grace. */
  due(): string[] {
    const now = this.now()
    return [...this.marks].flatMap(([pane, mark]) =>
      mark.release !== undefined || (mark.resetsAt !== null && now >= mark.resetsAt + LIFT_GRACE_MS) ? [pane] : [])
  }

  /** Called by the lift step only once every run the pane touches has saved its re-arm. */
  lifted(pane: string): void {
    const mark = this.marks.get(pane)
    if (mark === undefined) return
    this.marks.delete(pane)
    if (mark.release !== 'moved-on') this.stale.set(pane, mark.line.text)
    this.revision += 1
    this.log(`usage limit in ${pane} lifted (${mark.release === undefined ? `reset ${resetText(mark.line)}`
      : mark.release === 'nudge' ? 'nudged' : 'it moved on'}); its stall clocks restarted`)
  }

  /**
   * The pane was seen working, or herdr confirmed a prompt into it. Whatever limit
   * line it shows next was printed since, so a line lifted earlier is no longer the
   * one on screen. Called for every `working` event in a drained batch, not only the
   * last: the pair a rejected prompt leaves, `working` then `done`, arrives in one.
   */
  noteActivity(pane: string): void {
    this.activeAt.set(pane, this.now())
    this.stale.delete(pane)
    this.nudgedUnmarked.delete(pane)
  }

  /** `hpipe nudge` queued a resume: release the hold, and keep the line on screen from holding it again. */
  nudge(pane: string): void {
    const mark = this.marks.get(pane)
    if (mark === undefined) this.nudgedUnmarked.add(pane)
    else this.release(mark, 'nudge')
  }

  /** Marked panes due a fresh reading; a mark carried over from a restart is due at once. */
  recheckDue(): string[] {
    return [...this.marks.keys()].filter((pane) => this.needsRead(pane))
  }

  /** Whether the pane's last reading is too old to answer from. */
  needsRead(pane: string): boolean {
    const age = this.now() - (this.readAt.get(pane) ?? 0)
    return age >= (this.marks.has(pane) ? RECHECK_MS : FRESH_MS)
  }

  /** An empty list is a failed `pane list`, not a session with no panes. */
  forgetGone(livePanes: ReadonlySet<string>): void {
    if (livePanes.size === 0) return
    for (const pane of [...this.marks.keys()]) {
      if (livePanes.has(pane)) continue
      this.marks.delete(pane)
      this.revision += 1
    }
    for (const map of [this.stale, this.readAt, this.activeAt]) {
      for (const pane of [...map.keys()]) if (!livePanes.has(pane)) map.delete(pane)
    }
  }

  holds(): Record<string, PaneHold> {
    const out: Record<string, PaneHold> = {}
    for (const [pane, mark] of this.marks) {
      out[pane] = {
        since: mark.since, failures: 0, code: USAGE_LIMIT, until: mark.resetsAt, reset: resetText(mark.line),
      }
    }
    return out
  }

  snapshot(): PersistedLimits {
    const marks: PersistedLimits['marks'] = {}
    for (const [pane, mark] of this.marks) marks[pane] = { line: mark.line, since: mark.since, resets_at: mark.resetsAt }
    return { marks, stale: Object.fromEntries(this.stale) }
  }
}

export function resetText(line: LimitLine): string | null {
  if (line.when === null) return null
  return line.zone === null ? line.when : `${line.when} (${line.zone})`
}

export interface LimitIO {
  paneReadStyled(target: string, lines: number): Promise<string>
  agentStatus(target: string): Promise<AgentStatus>
}

export function readingFrom(screen: string, status: AgentStatus): LimitReading {
  const scan = limitLineOn(screen)
  return { status, line: scan.line, boxSeen: scan.boxSeen, autoContinue: scan.autoContinue }
}

/** herdr's failed `pane read` comes back as an empty screen, which says nothing either way: null. */
export async function readLimit(io: LimitIO, pane: string, status?: AgentStatus): Promise<LimitReading | null> {
  const screen = await io.paneReadStyled(pane, SCREEN_LINES)
  if (screen === '') return null
  return readingFrom(screen, status ?? await io.agentStatus(pane))
}

/**
 * For the stall step: whether the pane is limited, reading it first when the last
 * reading is too old to answer from. This is what catches a limit no event or send
 * revealed — a 429 too brief for herdr to report `working`, or panes that went idle
 * before the supervisor restarted.
 */
export function limitedNow(limits: UsageLimits, io: LimitIO): (pane: string) => Promise<boolean> {
  return async (pane) => {
    if (limits.isLimited(pane)) return true
    if (!limits.needsRead(pane)) return false
    const reading = await readLimit(io, pane)
    if (reading !== null) limits.observe(pane, reading)
    return limits.isLimited(pane)
  }
}

/**
 * The tick's limit step, before anything is delivered. Reads every run pane whose
 * agent went idle or done in this drain (the orchestrator's too: `applyEvents` drops
 * its events, this does not), and every mark due a re-check; applies `hpipe nudge`'s
 * events. A pane whose last event is `working` needs no read: there is nothing to
 * detect, and a mark on it is released. A pane that belongs to no run is never read.
 */
export async function checkLimits(
  limits: UsageLimits, io: LimitIO, drained: readonly QueuedEvent[], runPanes: ReadonlySet<string>,
): Promise<void> {
  const lastStatus = new Map<string, AgentStatus>()
  for (const event of drained) {
    if (event.pane_id === undefined) continue
    if (event.kind === 'pipeline.nudge') limits.nudge(event.pane_id)
    if (event.kind !== 'pane.agent_status_changed' || event.agent_status === undefined) continue
    if (!runPanes.has(event.pane_id)) continue
    if (event.agent_status === 'working') limits.noteActivity(event.pane_id)
    lastStatus.set(event.pane_id, event.agent_status)
  }

  const toRead = new Map<string, AgentStatus | undefined>()
  for (const [pane, status] of lastStatus) {
    if (isAgentReady(status)) toRead.set(pane, status)
    else limits.observe(pane, { status, line: null, boxSeen: false, autoContinue: false })
  }
  for (const pane of limits.recheckDue()) if (!toRead.has(pane)) toRead.set(pane, undefined)

  await Promise.all([...toRead].map(async ([pane, status]) => {
    const reading = await readLimit(io, pane, status)
    if (reading !== null) limits.observe(pane, reading)
  }))
}
