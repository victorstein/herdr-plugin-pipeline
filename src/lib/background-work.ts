import { inputBoxBounds, withoutEscapes } from './screen'

export interface BackgroundScan {
  /** Whether a Claude input box was found. Without one the screen says nothing either way. */
  boxSeen: boolean
  /** What Claude Code shows running behind the prompt, in its own words: `1 shell`, `ui-dev subagent`. */
  running: string[]
}

/** A glyph some labels lead with: `◇ 1 cloud session`, and the flagged pill's `▪ 3 background`. */
const GLYPH = '(?:[^\\w\\s]+ )?'

/**
 * The background pill's labels that are the agent's own work, exactly as Claude Code
 * 2.1.296 draws them (`Sjr` in its bundle): shells and monitors joined by a comma, one
 * label per other kind, and `N background tasks` for a mix. `N background` is the same
 * pill behind the `tengu_copper_thistle` flag.
 */
const WORK = new RegExp(`^${GLYPH}\\d+ (?:shells?|monitors?|local agents?|teams?|background dynamic workflows?|` +
  'remote dynamic workflows?|cloud sessions?|MCP tasks?|background tasks?|background)$')

/** Labels of what Claude Code runs for itself, or of a standing service, which no phase waits on. */
const NOT_WORK = new RegExp(`^(?:dreaming|auto-mode scan|memory import(?: \\d+/\\d+)?|${GLYPH}ultraplan` +
  '(?: ready| needs your input)?|\\d+ Artifact comment monitors?)$')

/**
 * What marks the footer line among the lines under the box: the permission mode, a
 * hint, or the agents-view hint `← 1 agent`, which a session that never ran a
 * subagent shows too and which is not work. A user-defined status line sits beside
 * it and can say anything, `main · 3 tasks` included, so only this line is read.
 */
const FOOTER_MARK = /^(?:⏵⏵|⏸|⏵ |\? for shortcuts|← \d+ agents?|esc to |ctrl\+\S+ to |\/tasks to see subagents|↓ to |hold \S+ to speak|! for shell mode)/

/**
 * A row of the agents panel Claude draws under the footer while a subagent runs,
 * or waits on a shell of its own: `◯ ui-dev  Waiting on x4pro firmware build   2m 10s · ↓ 112.8k tokens`.
 * The pill does not count such a subagent. `⏺ main` heads the panel and is the
 * session itself.
 */
const AGENT_ROW = /^[◯○●◉◎⏺]\s+(\S+)\s.*[↑↓]\s*[\d.,]+[kKmM]?\s+tokens$/
const PANEL_HEAD = /^⏺\s+main$/

/** The flagged pill appends its own hint, `3 background (↓ to manage)`. */
const segmentsOf = (line: string): string[] =>
  line.trim().split(' · ').map((segment) => segment.trim().replace(/\s*\(↓ to [^)]*\)$/, ''))

const pillItems = (segment: string): string[] => segment.split(', ')

const isPill = (segment: string): boolean =>
  pillItems(segment).every((item) => WORK.test(item) || NOT_WORK.test(item))

/** The footer: the last line marked as one, or a last line that is nothing but the pill. */
function footerLine(lines: readonly string[]): string | null {
  const marked = lines.findLast((line) => segmentsOf(line).some((segment) => FOOTER_MARK.test(segment)))
  if (marked !== undefined) return marked
  const last = lines.findLast((line) => line.trim().length > 0)
  return last !== undefined && segmentsOf(last).every(isPill) ? last : null
}

/**
 * Background work Claude Code shows in the pane: subagents, shells, monitors and
 * the rest of what it runs behind the prompt. herdr reports the pane `done` as
 * soon as the turn ends, so without this a worker whose implementer subagent was
 * still building read as stopped with uncommitted work. Measured on a live run.
 *
 * Only what is drawn below the input box counts: the transcript's `✻ … · 2 shells
 * still running` was true when that turn ended and says nothing about now.
 */
export function backgroundWorkOn(screen: string): BackgroundScan {
  const lines = withoutEscapes(screen).split('\n')
  const bounds = inputBoxBounds(lines)
  if (bounds === null) return { boxSeen: false, running: [] }
  const below = lines.slice(bounds.close + 1)
  const panelAt = below.findIndex((line) => PANEL_HEAD.test(line.trim()) || AGENT_ROW.test(line.trim()))
  const footer = footerLine(panelAt === -1 ? below : below.slice(0, panelAt))
  const running = footer === null
    ? []
    : segmentsOf(footer).filter(isPill).flatMap(pillItems).filter((item) => WORK.test(item))
  for (const line of panelAt === -1 ? [] : below.slice(panelAt)) {
    const agent = AGENT_ROW.exec(line.trim())
    if (agent !== null && agent[1] !== 'main') running.push(`${agent[1]} subagent`)
  }
  return { boxSeen: true, running }
}
