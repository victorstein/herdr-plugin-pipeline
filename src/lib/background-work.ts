import { inputBoxBounds, withoutEscapes } from './screen'

export interface BackgroundScan {
  /** Whether a Claude input box was found. Without one the screen says nothing either way. */
  boxSeen: boolean
  /** What Claude Code shows running behind the prompt, in its own words: `1 shell`, `ui-dev subagent`. */
  running: string[]
}

/**
 * One item of the footer's background pill, which joins them with commas inside
 * one ` · ` segment: `⏵⏵ bypass permissions on · 1 shell, 4 monitors · ← 1 agent`.
 * The kinds are Claude Code 2.1's own task labels. `← 1 agent` is not one: it is
 * the hint for the agents view, and a session that never ran a subagent shows it
 * too, so the arrow keeps it out.
 */
const PILL_ITEM = /^\d+ (?:(?:shell|monitor|subagent|agent|workflow|teammate|MCP task|background task|task)s?|background)$/

/**
 * A row of the agents panel Claude draws under the footer while a subagent runs,
 * or waits on a shell of its own: `◯ ui-dev  Waiting on x4pro firmware build   2m 10s · ↓ 112.8k tokens`.
 * The pill does not count such a subagent. `⏺ main` heads the panel and is the
 * session itself.
 */
const AGENT_ROW = /^[◯○●◉◎⏺]\s+(\S+)\s.*[↑↓]\s*[\d.,]+[kKmM]?\s+tokens$/

/**
 * Background work Claude Code shows in the pane: subagents, shells, monitors and
 * the rest of what it runs behind the prompt. herdr reports the pane `done` as
 * soon as the turn ends, so without this a worker whose implementer subagent was
 * still building read as stopped with uncommitted work. Measured on a live run.
 *
 * Only what is drawn below the input box counts. The transcript's `✻ … · 2 shells
 * still running` was true when that turn ended and says nothing about now, and a
 * user-defined status line sits there too, so a pill item must be a whole segment.
 */
export function backgroundWorkOn(screen: string): BackgroundScan {
  const lines = withoutEscapes(screen).split('\n')
  const bounds = inputBoxBounds(lines)
  if (bounds === null) return { boxSeen: false, running: [] }
  const running: string[] = []
  for (const line of lines.slice(bounds.close + 1)) {
    const text = line.trim()
    const agent = AGENT_ROW.exec(text)
    if (agent !== null) {
      if (agent[1] !== 'main') running.push(`${agent[1]} subagent`)
      continue
    }
    for (const segment of text.split(' · ')) {
      const items = segment.trim().split(', ')
      if (items.every((item) => PILL_ITEM.test(item))) running.push(...items)
    }
  }
  return { boxSeen: true, running }
}
