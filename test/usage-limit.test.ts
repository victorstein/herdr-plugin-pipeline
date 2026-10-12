import { expect, test } from 'bun:test'
import { type LimitLine, limitLineOn, resetAt } from '../src/lib/usage-limit'

const MANAGUA = 'America/Managua'
const RULE = '─'.repeat(60)
const ESC = '\x1b'
const GREY = `${ESC}[38;2;153;153;153m`
const RED = `${ESC}[38;2;255;107;128m`
const RESET = `${ESC}[0m`

/** A Claude screen: the transcript lines, then an input box, then a status line. */
const claude = (transcript: string[], box = '❯ ', status = '  ⏵⏵ bypass permissions on (shift+tab to cycle)') =>
  [...transcript, '', RULE, box, RULE, status].join('\n')

const limit = (when = `5:20am (${MANAGUA})`, label = 'session limit') =>
  `  ⎿  You've hit your ${label} · resets ${when}`

// Reconstructed from the orchestrator's `herdr pane read` of wD:p1 at 2026-10-11T11:21:23Z, with the blank
// lines and rules its grep removed put back.
const WORKER_AT_THE_LIMIT = claude([
  '  If you are back here from a BLOCKER verdict (pass 0), the review is the newest file for this',
  '  bead under docs/superpowers/reviews/. Fix every BLOCKER and every MAJOR you accept before',
  '  rewriting anything else.',
  '  Commit and push the plan, then stop.',
  "  ⎿  You've hit your session limit · resets 5:20am (America/Managua)",
  '     /upgrade to increase your usage limit.',
  '',
  '✻ Worked for 0s · done 4:07 AM',
  '',
  '❯ Still working? — run berean-os-20261011-responsiveness-fixes-from-the-device-bas-y98z, phase plan (t1, perf/r20-fast-entry-refresh)',
  '  This phase has been open 45 minutes. Nothing has appeared at:',
  '  This is probe 1 of 3. After 3 unanswered probes this phase is escalated to the human and stops moving on its own.',
  "  ⎿  You've hit your session limit · resets 5:20am (America/Managua)",
  '     /upgrade to increase your usage limit.',
  '',
  '✻ Brewed for 0s · done 4:52 AM',
], '❯ ', '  [Opus 5.5 (1M context)] │ Ctx ██░░░░░░░░ 27% │ 7d ██░░░░░░░░ 23% ~1d21h')

// wE:p1 at the same moment: its background reviewer failed on the limit first, as assistant output.
const REVIEWER_FAILED_FIRST = claude([
  '⏺ Agent "Adversarial spec review pass 0" failed: Agent terminated early due to an API error: You\'ve hit your session limit · resets 5:20am (America/Managua)',
  '(error type rate_limit, HTTP 429, request id req_011CfvGNxc5A8cBbwtEfCTfE, model sent to the API: claude-opus-5-5)',
  "  ⎿  You've hit your session limit · resets 5:20am (America/Managua)",
  '     /upgrade to increase your usage limit.',
  '',
  '✻ Brewed for 10m 33s · done 4:13 AM · 2 shells still running',
])

const at = (iso: string) => Date.parse(iso)
const lineOf = (screen: string): LimitLine => {
  const { line } = limitLineOn(screen)
  if (line === null) throw new Error('no limit line')
  return line
}

test('the live capture reads as a session limit with its reset and zone', () => {
  expect(limitLineOn(WORKER_AT_THE_LIMIT)).toEqual({
    boxSeen: true, autoContinue: false,
    line: {
      label: 'session limit', when: '5:20am', zone: MANAGUA,
      text: "⎿  You've hit your session limit · resets 5:20am (America/Managua)",
    },
  })
  expect(lineOf(REVIEWER_FAILED_FIRST).label).toBe('session limit')
})

test('the styled screen reads the same: the dim or grey anchor is kept, every escape dropped', () => {
  const styled = claude([
    `${RESET}${GREY}⏺ ${RESET}Opened the PR.`,
    `  ${GREY}⎿  ${RESET}${RED}You've hit your session limit · resets 10:20am (America/Managua)${RESET}\r`,
    `     ${GREY}/upgrade to increase your usage limit.${RESET}\r`,
  ])
  expect(limitLineOn(styled).line?.when).toBe('10:20am')
  const faint = claude([`  ${ESC}[2m⎿${ESC}[22m  You've hit your session limit · resets 10:20am (America/Managua)`])
  expect(limitLineOn(faint).line?.when).toBe('10:20am')
})

test('every label Claude Code renders is a limit', () => {
  for (const label of [
    'session limit', 'weekly limit', 'Opus limit', 'Sonnet limit', 'Fable limit', 'usage credit limit', 'limit',
    'usage limit',
  ]) {
    expect(lineOf(claude([limit(`3am (${MANAGUA})`, label)])).label, label).toBe(label)
  }
})

test('a team or org budget names the limit whose reset it gives, and a saved-progress note is ignored', () => {
  const team = claude(["  ⎿  You've hit your team's shared budget · ask your admin to raise it at https://claude.ai/admin · " +
    'your session limit resets 5:20am (America/Managua)'])
  expect(lineOf(team)).toMatchObject({
    label: "team's shared budget", resetting: 'session limit', when: '5:20am', zone: MANAGUA,
  })
  expect(lineOf(claude([`${limit()} · progress saved`]))).toMatchObject({ label: 'session limit', when: '5:20am', zone: MANAGUA })
  expect(lineOf(claude(["  ⎿  You've reached your Fable limit."]))).toMatchObject({ label: 'Fable limit', when: null })
  expect(lineOf(claude(["  ⎿  You're out of usage credits · Switch to another model"]))).toMatchObject({ label: 'usage credits' })
})

test('a line with no reset is still a limit, with nothing to date it by', () => {
  expect(lineOf(claude(["  ⎿  You've hit your usage credit limit"]))).toMatchObject({
    label: 'usage credit limit', when: null, zone: null,
  })
})

test('a line a narrow pane wrapped is joined back before it is read, wherever it broke', () => {
  const wraps = [
    ["  ⎿  You've hit your session limit · resets 10:20am (America/", '     Managua)'],
    ["  ⎿  You've hit your session limit · resets 10:20am", '     (America/Managua)'],
    ["  ⎿  You've hit your session limit · resets", '     10:20am (America/Managua)'],
  ]
  for (const wrapped of wraps) {
    expect(lineOf(claude([...wrapped, '     /upgrade to increase your usage limit.'])), wrapped[1])
      .toMatchObject({ label: 'session limit', when: '10:20am', zone: MANAGUA })
  }
  expect(lineOf(claude(["  ⎿  You've hit your usage credit limit", '     /upgrade to increase your usage limit.'])))
    .toMatchObject({ label: 'usage credit limit', when: null })
})

test('assistant output after the line means the agent has moved on, on macOS and elsewhere', () => {
  for (const glyph of ['⏺', '●']) {
    const answered = claude([limit(), '', '❯ carry on', '', `${glyph} Picking up the review where it stopped.`])
    expect(limitLineOn(answered).line, glyph).toBeNull()
  }
})

test('a user turn after the line does not hide it: a rejected probe is followed by the line again', () => {
  expect(lineOf(WORKER_AT_THE_LIMIT).when).toBe('5:20am')
  expect(limitLineOn(claude([limit(), '', '❯ /model sonnet', '  ⎿  Set model to Sonnet'])).line).not.toBeNull()
})

test('a quoted copy is not a limit: assistant output, deeper tool output, or prose', () => {
  const quoted = [
    '⏺ Agent "review" failed: You\'ve hit your session limit · resets 5:20am (America/Managua)',
    "      ⎿  You've hit your session limit · resets 5:20am (America/Managua)",
    "  The message reads You've hit your session limit · resets 5:20am (America/Managua).",
  ]
  for (const line of quoted) expect(limitLineOn(claude([line])).line, line).toBeNull()
})

test('the box and the status line can neither fake nor mask a limit', () => {
  const draft = claude(['⏺ Done.'], "❯   ⎿  You've hit your session limit · resets 5:20am (America/Managua)")
  expect(limitLineOn(draft).line).toBeNull()
  const glyphInStatus = claude([limit()], '❯ ', '  ⏺ 3 background tasks')
  expect(limitLineOn(glyphInStatus).line).not.toBeNull()
})

test('with no input box on screen nothing is read, and the caller is told so', () => {
  expect(limitLineOn([limit(), '', 'Wait here, then continue automatically when the limit resets'].join('\n')))
    .toEqual({ line: null, boxSeen: false, autoContinue: false })
  expect(limitLineOn('')).toEqual({ line: null, boxSeen: false, autoContinue: false })
})

test('a screen with no message is no limit', () => {
  expect(limitLineOn(claude(['⏺ Wrote the plan.']))).toEqual({ line: null, boxSeen: true, autoContinue: false })
})

test('Claude\'s own auto-continue counts only while its last notice below the line says it is armed', () => {
  const armed = (...notices: string[]) => limitLineOn(claude([limit(), ...notices])).autoContinue
  expect(armed('  Usage limit reached · continuing automatically at 10:20am · esc to cancel')).toBe(true)
  expect(armed('  Continuing automatically at 10:20am')).toBe(true)
  expect(armed('  Usage limit reached · continuing automatically at 10:20am · esc to cancel',
    '  Automatic continue cancelled')).toBe(false)
  expect(armed('  Continuing automatically at 10:20am', '  Usage limit has reset · press enter to continue')).toBe(false)
  expect(limitLineOn(claude(['  Continuing automatically at 5:20am', '⏺ Resumed.', limit()])).autoContinue).toBe(false)
  expect(limitLineOn(WORKER_AT_THE_LIMIT).autoContinue).toBe(false)
})

// Managua is UTC−6 all year.
const time = (when: string, label = 'session limit', zone: string | null = MANAGUA): LimitLine =>
  ({ label, when, zone, text: '' })

test('a time-only reset is the first occurrence after it was first seen', () => {
  expect(resetAt(time('10:20am'), at('2026-10-11T12:34:14Z'))).toBe(at('2026-10-11T16:20:00Z'))
  // 22:30 local on the 11th; 2:20am is the 12th.
  expect(resetAt(time('2:20am'), at('2026-10-12T04:30:00Z'))).toBe(at('2026-10-12T08:20:00Z'))
})

test('the hour alone, noon, midnight and a spaced upper-case meridiem all parse', () => {
  const seen = at('2026-10-11T13:00:00Z')
  expect(resetAt(time('8am'), seen)).toBe(at('2026-10-11T14:00:00Z'))
  expect(resetAt(time('12pm'), seen)).toBe(at('2026-10-11T18:00:00Z'))
  expect(resetAt(time('3:30 PM', 'weekly limit'), seen)).toBe(at('2026-10-11T21:30:00Z'))
  expect(resetAt(time('12am', 'weekly limit'), seen)).toBe(at('2026-10-12T06:00:00Z'))
})

test('a line first seen up to 15 minutes after its own reset dates to the reset just passed', () => {
  expect(resetAt(time('10:20am'), at('2026-10-11T16:31:00Z'))).toBe(at('2026-10-11T16:20:00Z'))
  expect(resetAt(time('10:20am', 'weekly limit'), at('2026-10-11T16:34:00Z'))).toBe(at('2026-10-11T16:20:00Z'))
  // Past the tolerance a weekly time is tomorrow's: its last day reads time-only.
  expect(resetAt(time('10:20am', 'weekly limit'), at('2026-10-11T16:36:00Z'))).toBe(at('2026-10-12T16:20:00Z'))
})

test('a team budget that resets with the session window is dated by the session rule', () => {
  const team: LimitLine = { label: "team's shared budget", resetting: 'session limit', when: '10:20am', zone: MANAGUA, text: '' }
  expect(resetAt(team, at('2026-10-12T10:00:00Z'))).toBe(at('2026-10-11T16:20:00Z'))
})

test('a session limit is never more than five hours away, so a later time is the one already gone', () => {
  // 04:00 local; 10:20am is 6h20m ahead, past a session window.
  expect(resetAt(time('10:20am'), at('2026-10-12T10:00:00Z'))).toBe(at('2026-10-11T16:20:00Z'))
  // 05:30 local; 10:20am is 4h50m ahead.
  expect(resetAt(time('10:20am'), at('2026-10-12T11:30:00Z'))).toBe(at('2026-10-12T16:20:00Z'))
})

test('a weekly limit in its last day reads time-only and dates up to a day ahead', () => {
  // 08:00 local; 10pm is 14h ahead.
  expect(resetAt(time('10pm', 'weekly limit'), at('2026-10-11T14:00:00Z'))).toBe(at('2026-10-12T04:00:00Z'))
})

test('a dated reset takes the year nearest first sight, or the year it names', () => {
  expect(resetAt(time('Sep 22 at 3am', 'weekly limit'), at('2026-09-20T12:00:00Z'))).toBe(at('2026-09-22T09:00:00Z'))
  expect(resetAt(time('Jan 2 at 9:30pm', 'weekly limit'), at('2026-12-30T12:00:00Z'))).toBe(at('2027-01-03T03:30:00Z'))
  expect(resetAt(time('Jan 2, 2027 at 3:30am', 'weekly limit'), at('2026-12-28T12:00:00Z')))
    .toBe(at('2027-01-02T09:30:00Z'))
})

test('a zone with daylight saving converts on the right side of the change', () => {
  // New York: EDT (UTC−4) until 2026-11-01 06:00Z, then EST (UTC−5).
  const ny = (when: string) => time(when, 'session limit', 'America/New_York')
  expect(resetAt(ny('3pm'), at('2026-10-31T16:00:00Z'))).toBe(at('2026-10-31T19:00:00Z'))
  expect(resetAt(ny('3pm'), at('2026-11-01T17:00:00Z'))).toBe(at('2026-11-01T20:00:00Z'))
})

test('a line with no zone is read in the local zone', () => {
  expect(resetAt(time('10:20am', 'session limit', null), at('2026-10-11T12:34:14Z'), MANAGUA))
    .toBe(at('2026-10-11T16:20:00Z'))
})

test('a reset it cannot read is null, never a guess', () => {
  const seen = at('2026-10-11T12:00:00Z')
  expect(resetAt(time('soon'), seen)).toBeNull()
  expect(resetAt(time('10:20am', 'session limit', 'Mars/Olympus_Mons'), seen)).toBeNull()
  expect(resetAt({ label: 'usage credit limit', when: null, zone: null, text: '' }, seen)).toBeNull()
  expect(resetAt(time('Smarch 3 at 3am', 'weekly limit'), seen)).toBeNull()
})
