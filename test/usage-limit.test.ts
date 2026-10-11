import { expect, test } from 'bun:test'
import { UNPARSED_RESET_MS, usageLimitOn } from '../src/lib/usage-limit'

const MANAGUA = 'America/Managua'
const SESSION = (spec: string, zone = MANAGUA) => `You've hit your session limit · resets ${spec} (${zone})`

const screen = (...lines: string[]) => [
  '⏺ Pushed the spec and opened the review.',
  ...lines,
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Managua is UTC−6 all year.
const at = (iso: string) => Date.parse(iso)

test('a session limit resets at the named wall time in the named zone', () => {
  const limit = usageLimitOn(screen(`  ⎿  ${SESSION('10:20am')}`), at('2026-10-11T12:34:14Z'))
  expect(limit).toEqual({
    kind: 'session', resetsAt: at('2026-10-11T16:20:00Z'), text: SESSION('10:20am'),
  })
})

test('the hour alone, noon and midnight all parse', () => {
  const seenAt = at('2026-10-11T13:00:00Z')
  expect(usageLimitOn(screen(SESSION('8am')), seenAt)?.resetsAt).toBe(at('2026-10-11T14:00:00Z'))
  expect(usageLimitOn(screen(SESSION('12pm')), seenAt)?.resetsAt).toBe(at('2026-10-11T18:00:00Z'))
  // 12:40am tomorrow is too far ahead for a session limit, so it is the one just gone.
  expect(usageLimitOn(screen(SESSION('12:40am')), seenAt)?.resetsAt).toBe(at('2026-10-11T06:40:00Z'))
})

test('a reset just past midnight local is the next day', () => {
  // 22:30 local on the 11th; resets 2:20am local on the 12th.
  expect(usageLimitOn(screen(SESSION('2:20am')), at('2026-10-12T04:30:00Z'))?.resetsAt)
    .toBe(at('2026-10-12T08:20:00Z'))
})

test('a reset already past is read as past, so the pane is resumable now', () => {
  // Seen at 16:25Z, ten minutes after a 10:20am-local reset.
  const limit = usageLimitOn(screen(SESSION('10:20am')), at('2026-10-11T16:30:00Z'))
  expect(limit?.resetsAt).toBe(at('2026-10-11T16:20:00Z'))
})

test('a session reset is never read as more than six hours ahead', () => {
  // A session window is five hours, rounded on the clock; 10:20am is 6h20m away from 04:00 local,
  // so it must be the one that has passed.
  const limit = usageLimitOn(screen(SESSION('10:20am')), at('2026-10-12T10:00:00Z'))
  expect(limit?.resetsAt).toBe(at('2026-10-11T16:20:00Z'))
})

test('a zone with daylight saving converts on the right side of the change', () => {
  // New York: EDT (UTC−4) until 2026-11-01 06:00Z, then EST (UTC−5).
  const zone = 'America/New_York'
  expect(usageLimitOn(screen(SESSION('3pm', zone)), at('2026-10-31T16:00:00Z'))?.resetsAt)
    .toBe(at('2026-10-31T19:00:00Z'))
  expect(usageLimitOn(screen(SESSION('3pm', zone)), at('2026-11-01T17:00:00Z'))?.resetsAt)
    .toBe(at('2026-11-01T20:00:00Z'))
})

test('a weekly limit names its date, in the year nearest when it was seen', () => {
  const text = "You've hit your weekly limit · resets Sep 22 at 3am (America/Managua)"
  expect(usageLimitOn(screen(text), at('2026-09-20T12:00:00Z'))).toEqual({
    kind: 'weekly', resetsAt: at('2026-09-22T09:00:00Z'), text,
  })
  const acrossNewYear = "You've hit your weekly limit · resets Jan 2 at 9:30pm (America/Managua)"
  expect(usageLimitOn(screen(acrossNewYear), at('2026-12-30T12:00:00Z'))?.resetsAt)
    .toBe(at('2027-01-03T03:30:00Z'))
})

test('a reset it cannot read still holds, for a short while, and is re-read then', () => {
  const seenAt = at('2026-10-11T12:00:00Z')
  for (const line of [SESSION('soon'), SESSION('10:20am', 'Mars/Olympus_Mons')]) {
    expect(usageLimitOn(screen(line), seenAt)?.resetsAt, line).toBe(seenAt + UNPARSED_RESET_MS)
  }
})

test('a message the agent has answered since is history, not a limit', () => {
  const answered = screen(SESSION('10:20am'), '', '❯ carry on', '', '⏺ Picking up the review where it stopped.')
  expect(usageLimitOn(answered, at('2026-10-11T12:40:00Z'))).toBeNull()
})

test('the last of two messages is the one that counts', () => {
  const twice = screen(SESSION('5:20am'), '⏺ Resumed the spec review.', `  ⎿  ${SESSION('10:20am')}`)
  expect(usageLimitOn(twice, at('2026-10-11T12:40:00Z'))?.resetsAt).toBe(at('2026-10-11T16:20:00Z'))
})

test('a screen with no message is no limit', () => {
  expect(usageLimitOn(screen('⏺ Wrote the plan.'), at('2026-10-11T12:00:00Z'))).toBeNull()
  expect(usageLimitOn('', at('2026-10-11T12:00:00Z'))).toBeNull()
})
