import { backgroundWorkOn } from '../lib/background-work'
import { SCREEN_LINES } from '../lib/screen'
import type { QueuedEvent } from '../lib/types'
import type { LimitIO } from './usage-limits'

/** How long a reading that showed work, or showed no input box, answers before the pane is read again. */
export const BACKGROUND_RECHECK_MS = 60_000

export interface ScreenReader {
  paneReadStyled(target: string, lines: number): Promise<string>
}

interface Reading {
  /** The last reading that found the input box; null until one has. */
  seen: readonly string[] | null
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
    this.readings.set(pane, { seen: scan.boxSeen ? scan.running : previous, readAt: this.now() })
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
  async running(pane: string, io: ScreenReader): Promise<readonly string[]> {
    if (this.needsRead(pane)) this.observe(pane, await io.paneReadStyled(pane, SCREEN_LINES))
    return this.lastSeen(pane)
  }

  /** The last reading alone, never a read: for text composed from what is already known. */
  lastSeen(pane: string): readonly string[] {
    return this.readings.get(pane)?.seen ?? []
  }

  private needsRead(pane: string): boolean {
    const reading = this.readings.get(pane)
    if (reading === undefined) return true
    if (reading.seen !== null && reading.seen.length === 0) return false
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
