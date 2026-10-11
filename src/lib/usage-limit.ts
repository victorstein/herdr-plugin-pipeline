export interface UsageLimit {
  kind: 'session' | 'weekly'
  resetsAt: number
  /** The message as the pane shows it, for logs and the orchestrator's note. */
  text: string
}

const MESSAGE = /You've hit your (session|weekly) limit · resets (.+?) \(([^)]+)\)/
const ASSISTANT_OUTPUT = /^\s*⏺/
const TIME = /^(?:([A-Za-z]{3})[a-z]* (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * A session window is five hours and the message rounds its reset on the clock, so
 * a reset more than six hours past the moment it was seen is a day early, not late.
 */
const SESSION_AHEAD_MAX_MS = 6 * HOUR_MS

/** A message the pane shows but this parser cannot date is held this long, then read again. */
export const UNPARSED_RESET_MS = 30 * 60_000

/**
 * The limit the pane is stopped on, or null. Only the last message counts, and only
 * while the agent has said nothing below it: one it answered since is scrollback.
 */
export function usageLimitOn(screen: string, seenAt: number): UsageLimit | null {
  const lines = screen.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (ASSISTANT_OUTPUT.test(line) && !MESSAGE.test(line)) return null
    const match = MESSAGE.exec(line)
    if (match === null) continue
    const kind = match[1] === 'weekly' ? 'weekly' : 'session'
    const resetsAt = resetTime(kind, (match[2] ?? '').trim(), match[3] ?? '', seenAt) ?? seenAt + UNPARSED_RESET_MS
    return { kind, resetsAt, text: match[0] }
  }
  return null
}

function resetTime(kind: UsageLimit['kind'], spec: string, zone: string, seenAt: number): number | null {
  const time = TIME.exec(spec)
  if (time === null) return null
  const [, monthName, dayText, hourText, minuteText, meridiem] = time
  const hour = (Number(hourText) % 12) + (meridiem?.toLowerCase() === 'pm' ? 12 : 0)
  const minute = Number(minuteText ?? '0')
  const seenDay = zonedDate(seenAt, zone)
  if (seenDay === null) return null

  if (monthName !== undefined) {
    const month = MONTHS.indexOf(monthName.toLowerCase()) + 1
    if (month === 0) return null
    const candidates = [-1, 0, 1].map((offset) =>
      zonedWallTimeToUtc(seenDay.year + offset, month, Number(dayText), hour, minute, zone))
    return nearest(candidates, seenAt)
  }
  if (kind === 'weekly') return null

  const candidates = [-1, 0, 1].map((offset) => {
    const day = new Date(Date.UTC(seenDay.year, seenDay.month - 1, seenDay.day + offset))
    return zonedWallTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, zone)
  })
  return candidates.find((at) => at > seenAt - (DAY_MS - SESSION_AHEAD_MAX_MS) && at <= seenAt + SESSION_AHEAD_MAX_MS) ??
    nearest(candidates, seenAt)
}

function nearest(candidates: number[], to: number): number | null {
  if (candidates.length === 0) return null
  return candidates.reduce((best, at) => (Math.abs(at - to) < Math.abs(best - to) ? at : best))
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

function zonedDate(at: number, zone: string): { year: number; month: number; day: number } | null {
  const parts = zonedParts(at, zone)
  return parts === null ? null : { year: parts.year, month: parts.month, day: parts.day }
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
