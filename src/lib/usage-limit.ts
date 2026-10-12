import { inputBoxBounds, withoutEscapes } from './screen'

/** Claude's usage-limit line as a pane shows it: `⎿ You've hit your <label> · resets <when> (<zone>)`. */
export interface LimitLine {
  label: string
  /** `5:20am`, `Sep 22 at 3am`, `Jan 2, 2027 at 3:30 AM`; null when the line names no reset. */
  when: string | null
  zone: string | null
  /** The line, trimmed, for logs, status and the notes. */
  text: string
}

export interface LimitScan {
  line: LimitLine | null
  /** Whether a Claude input box was found. Without one the screen says nothing either way. */
  boxSeen: boolean
}

/**
 * The `⎿` is Claude's own response prefix, two columns in. Tool output nested under
 * a call is indented further, and a background agent's failure quoting the message
 * is a `⏺` line, so neither matches.
 */
const LIMIT_LINE = /^\s{0,2}⎿\s+You've hit your (.+?)(?: · resets (.+?))?\s*$/
const ASSISTANT_OUTPUT = /^[⏺●]\s/
const ZONE_SUFFIX = /^(.*?) \(([^()]+)\)$/

/**
 * The limit the pane is stopped on: the last limit line above the input box, with
 * no assistant output after it. A user turn after it doesn't hide it, since a
 * rejected prompt is followed by the line again. The box and the status line below
 * it are skipped: a human's draft or a user-defined status line must neither fake
 * nor mask a limit.
 */
export function limitLineOn(screen: string): LimitScan {
  const lines = withoutEscapes(screen).split('\n')
  const bounds = inputBoxBounds(lines)
  if (bounds === null) return { line: null, boxSeen: false }
  for (let index = bounds.open - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (ASSISTANT_OUTPUT.test(line)) return { line: null, boxSeen: true }
    const joined = joinWrappedZone(line, index + 1 < bounds.open ? lines[index + 1] : undefined)
    const match = LIMIT_LINE.exec(joined)
    if (match !== null) return { line: limitLineFrom(match, joined), boxSeen: true }
  }
  return { line: null, boxSeen: true }
}

/** A narrow pane breaks the zone mid-name, where there is no space to break on. */
function joinWrappedZone(line: string, next: string | undefined): string {
  const open = line.lastIndexOf('(')
  if (open === -1 || line.indexOf(')', open) !== -1 || next === undefined) return line
  return line + next.trim()
}

function limitLineFrom(match: RegExpExecArray, line: string): LimitLine {
  const reset = match[2]?.trim()
  const zoned = reset === undefined ? null : ZONE_SUFFIX.exec(reset)
  return {
    label: match[1] ?? '',
    when: zoned?.[1] ?? reset ?? null,
    zone: zoned?.[2] ?? null,
    text: line.trim(),
  }
}

/** Claude continues on its own at the reset; the supervisor must not resume it too. */
export function autoContinues(screen: string): boolean {
  return /continuing automatically/i.test(withoutEscapes(screen))
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/**
 * A line first seen just after its own displayed reset is that reset, not
 * tomorrow's: the message shows minutes only, and a request re-rejected because
 * the server's reset came a little later prints the same time again.
 */
const FIRST_SIGHT_TOLERANCE_MS = 15 * MINUTE_MS

/** A session window is five hours; the quarter hour covers the minute rounding and the tolerance. */
const SESSION_AHEAD_MAX_MS = 5 * HOUR_MS + 15 * MINUTE_MS

const SESSION_LABEL = 'session limit'

const TIME_ONLY = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i
const DATED = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:, (\d{4}))? at (\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * When the limit resets, or null when the line can't be dated: never a guess, since
 * a guessed reset would resume a pane that may still be limited. Anchored on when the
 * line was first seen, not on the current read, so the same line always dates the same.
 *
 * Claude prints a time alone whenever the reset is 24 hours away or less, whatever
 * the limit, and a date beyond that, with the year when it differs.
 */
export function resetAt(
  line: LimitLine, firstSeenAt: number,
  localZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): number | null {
  if (line.when === null) return null
  const zone = line.zone ?? localZone
  if (zonedParts(firstSeenAt, zone) === null) return null

  const time = TIME_ONLY.exec(line.when)
  if (time !== null) {
    const [, hour, minute, meridiem] = time
    return timeOnlyReset(line.label, clock(hour, minute, meridiem), zone, firstSeenAt)
  }
  const dated = DATED.exec(line.when)
  if (dated === null) return null
  const [, monthName, day, year, hour, minute, meridiem] = dated
  const month = MONTHS.indexOf((monthName ?? '').toLowerCase()) + 1
  if (month === 0) return null
  const { h, m } = clock(hour, minute, meridiem)
  if (year !== undefined) return zonedWallTimeToUtc(Number(year), month, Number(day), h, m, zone)
  const seenYear = zonedParts(firstSeenAt, zone)?.year ?? new Date(firstSeenAt).getUTCFullYear()
  const candidates = [-1, 0, 1].map((offset) =>
    zonedWallTimeToUtc(seenYear + offset, month, Number(day), h, m, zone))
  return candidates.reduce((best, at) => (Math.abs(at - firstSeenAt) < Math.abs(best - firstSeenAt) ? at : best))
}

function clock(hour = '0', minute = '0', meridiem = 'a'): { h: number; m: number } {
  return { h: (Number(hour) % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0), m: Number(minute) }
}

function timeOnlyReset(
  label: string, { h, m }: { h: number; m: number }, zone: string, firstSeenAt: number,
): number | null {
  const seenDay = zonedParts(firstSeenAt, zone)
  if (seenDay === null) return null
  const occurrences = [-2, -1, 0, 1, 2].map((offset) => {
    const day = new Date(Date.UTC(seenDay.year, seenDay.month - 1, seenDay.day + offset))
    return zonedWallTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m, zone)
  })
  const next = occurrences.findIndex((at) => at > firstSeenAt - FIRST_SIGHT_TOLERANCE_MS)
  if (next <= 0) return null
  const reset = occurrences[next] as number
  if (label === SESSION_LABEL && reset - firstSeenAt > SESSION_AHEAD_MAX_MS) return occurrences[next - 1] as number
  return reset
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zonedParts(at: number, zone: string): ZonedParts | null {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(at))
  } catch {
    return null
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value)
  return {
    year: part('year'), month: part('month'), day: part('day'),
    hour: part('hour'), minute: part('minute'), second: part('second'),
  }
}

function zoneOffsetMs(at: number, zone: string): number {
  const parts = zonedParts(at, zone)
  if (parts === null) return 0
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return wall - (at - (at % 1000))
}

/** Twice, because the offset at the first guess can be the other side of a DST change. */
function zonedWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const first = wall - zoneOffsetMs(wall, zone)
  return wall - zoneOffsetMs(first, zone)
}
