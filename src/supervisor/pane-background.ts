import { backgroundWorkOn } from '../lib/background-work'
import { SCREEN_LINES } from '../lib/screen'
import type { QueuedEvent, Run, Task } from '../lib/types'
import type { LimitIO } from './usage-limits'

/** How long a reading that showed work, or showed no input box, answers before the pane is read again. */
export const BACKGROUND_RECHECK_MS = 60_000

export interface ScreenReader {
  paneReadStyled(target: string, lines: number): Promise<string>
}

export interface BackgroundWork {
  running: readonly string[]
  /** The part of `running` subagents are doing. */
  subagents: readonly string[]
}

export const NO_WORK: BackgroundWork = { running: [], subagents: [] }

interface Reading {
  /** The last reading that found the input box; null until one has. */
  seen: BackgroundWork | null
  readAt: number
}

/**
 * What Claude Code last showed running in the background of each pane. It is fed
 * by the screens the limit step already reads when a pane goes idle, so a pane is
 * read here only when it has no reading, or its last one showed work, which can
 * end without a turn, or no input box.
 *
 * A turn starting forgets the pane's reading: background work is only ever started
 * in a turn, and the idle that ends it is read again.
 */
export class PaneBackground {
  private readonly readings = new Map<string, Reading>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns the screen, so a reader can pass every screen it reads through here. */
  observe(pane: string, screen: string): string {
    const scan = backgroundWorkOn(screen)
    const previous = this.readings.get(pane)?.seen ?? null
    const seen = scan.boxSeen ? { running: scan.running, subagents: scan.subagents } : previous
    this.readings.set(pane, { seen, readAt: this.now() })
    return screen
  }

  noteTurns(events: readonly QueuedEvent[]): void {
    for (const event of events) {
      if (event.kind === 'pane.agent_status_changed' && event.agent_status === 'working' && event.pane_id) {
        this.readings.delete(event.pane_id)
      }
    }
  }

  /** The work running in the pane, reading it first when the last reading cannot answer for now. */
  async work(pane: string, io: ScreenReader): Promise<BackgroundWork> {
    if (this.needsRead(pane)) this.observe(pane, await io.paneReadStyled(pane, SCREEN_LINES))
    return this.lastSeen(pane)
  }

  /** The last reading alone, never a read: for text composed from what is already known. */
  lastSeen(pane: string): BackgroundWork {
    return this.readings.get(pane)?.seen ?? NO_WORK
  }

  private needsRead(pane: string): boolean {
    const reading = this.readings.get(pane)
    if (reading === undefined) return true
    if (reading.seen !== null && reading.seen.running.length === 0) return false
    return this.now() - reading.readAt >= BACKGROUND_RECHECK_MS
  }

  /** An empty list is a failed `pane list`, not a session with no panes. */
  forgetGone(livePanes: ReadonlySet<string>): void {
    if (livePanes.size === 0) return
    for (const pane of [...this.readings.keys()]) if (!livePanes.has(pane)) this.readings.delete(pane)
  }
}

/** `io`, with every screen it reads also read for background work. */
export function observedScreens(io: LimitIO, background: PaneBackground): LimitIO {
  return {
    paneReadStyled: async (pane, lines) => background.observe(pane, await io.paneReadStyled(pane, lines)),
    agentStatus: (pane) => io.agentStatus(pane),
  }
}

/** How long a fresh artifact waits for a subagent still running in its actor's pane before it is taken anyway. */
export const SUBAGENT_HOLD_MAX_MS = 10 * 60_000

/** Hold the row, or let it advance; `past` names the subagent work it advanced past at the cap. */
export type SubagentCall = { hold: true } | { hold: false; past?: readonly string[] }

export type SubagentHold = (key: string, paneId: string) => Promise<SubagentCall>

/** One record's phase entry: a hold never carries over to the next entry. */
export function holdKey(run: Run, task: Task | null): string {
  return `${run.run_id}:${task?.task_id ?? ''}:${(task ?? run).phase_entered_at}`
}

/**
 * Asked only once a row's own signal is fresh and settled. A subagent may still be
 * writing that artifact, so the row waits for it; nothing else holds a row. An
 * orchestrator's background shell polling `hpipe status` for the phase change held
 * the very phase it waited for, which only the stall ladder broke. Measured on live
 * runs. The wait is capped from the first hold, since a subagent can outlive its
 * use: in memory, so a restarted supervisor starts the clock again.
 */
export class SubagentHolds {
  private readonly since = new Map<string, number>()

  constructor(
    private readonly subagentsIn: (paneId: string) => Promise<readonly string[]>,
    private readonly now: () => number = Date.now,
  ) {}

  readonly check: SubagentHold = async (key, paneId) => {
    const subagents = await this.subagentsIn(paneId)
    if (subagents.length === 0) {
      this.since.delete(key)
      return { hold: false }
    }
    const now = this.now()
    const since = this.since.get(key) ?? now
    if (now - since < SUBAGENT_HOLD_MAX_MS) {
      this.since.set(key, since)
      return { hold: true }
    }
    this.since.delete(key)
    return { hold: false, past: subagents }
  }
}

/** Appended to the transition just recorded, and to the supervisor's log. */
export function notePastSubagents(run: Run, what: string, past: readonly string[] | null): void {
  const entry = run.history.at(-1)
  if (past === null || entry === undefined) return
  const note = `advanced past background work still running (${past.join(', ')}) after ` +
    `${SUBAGENT_HOLD_MAX_MS / 60_000}m`
  entry.why = `${entry.why}; ${note}`
  console.error(`[pipeline] run ${run.run_id}: ${what} ${note}`)
}
