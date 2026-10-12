import { expect, test } from 'bun:test'
import type { LimitLine } from '../src/lib/usage-limit'
import type { AgentStatus } from '../src/lib/types'
import {
  checkLimits, FRESH_MS, LIFT_GRACE_MS, limitedNow, type LimitReading, readLimit, RECHECK_MS, UsageLimits,
} from '../src/supervisor/usage-limits'

const MANAGUA = 'America/Managua'
const at = (iso: string) => Date.parse(iso)
const T0 = at('2026-10-11T12:34:14Z')
const RESET = at('2026-10-11T16:20:00Z')

const line = (when = '10:20am', label = 'session limit'): LimitLine => ({
  label, when, zone: MANAGUA, text: `⎿  You've hit your ${label} · resets ${when} (${MANAGUA})`,
})
const reading = (over: Partial<LimitReading> = {}): LimitReading =>
  ({ status: 'done', line: line(), boxSeen: true, autoContinue: false, ...over })
const movedOn = reading({ line: null })

function limitsAt(start = T0) {
  const clock = { now: start }
  const logged: string[] = []
  const limits = new UsageLimits(() => clock.now, (m) => logged.push(m))
  return { limits, clock, logged }
}

test('an idle pane showing the line is marked, dated from first sight, and held in holds()', () => {
  const { limits, logged } = limitsAt()
  const before = limits.revision
  limits.observe('w4:p1', reading())
  expect(limits.isLimited('w4:p1')).toBe(true)
  expect(limits.get('w4:p1')).toMatchObject({ resetsAt: RESET, since: T0 })
  expect(limits.revision).toBeGreaterThan(before)
  expect(limits.holds()['w4:p1']).toEqual({
    since: T0, failures: 0, code: 'usage_limit', until: RESET, reset: `10:20am (${MANAGUA})`,
  })
  expect(logged.join('\n')).toContain('usage limit in w4:p1')
})

test('a working, blocked or unknown pane is never marked, whatever its screen shows', () => {
  for (const status of ['working', 'blocked', 'unknown'] as AgentStatus[]) {
    const { limits } = limitsAt()
    limits.observe('w4:p1', reading({ status }))
    expect(limits.isLimited('w4:p1'), status).toBe(false)
  }
})

test('a line whose reset is already past is old, and marks nothing', () => {
  const { limits } = limitsAt(RESET + LIFT_GRACE_MS + 1)
  limits.observe('w4:p1', reading())
  expect(limits.isLimited('w4:p1')).toBe(false)
})

test('a marked pane is released once it is seen working, or idle with the line gone', () => {
  for (const seen of [reading({ status: 'working', line: null }), movedOn]) {
    const { limits } = limitsAt()
    limits.observe('w4:p1', reading())
    limits.observe('w4:p1', seen)
    expect(limits.get('w4:p1')?.release).toBe('moved-on')
    expect(limits.due()).toEqual(['w4:p1'])
  }
})

test('an inconclusive reading keeps the mark, and still waits its turn before the next read', () => {
  const { limits, clock } = limitsAt()
  limits.observe('w4:p1', reading())
  clock.now += RECHECK_MS
  expect(limits.recheckDue()).toEqual(['w4:p1'])
  for (const seen of [reading({ status: 'blocked', line: null }), reading({ line: null, boxSeen: false })]) {
    limits.observe('w4:p1', seen)
    expect(limits.get('w4:p1')?.release).toBeUndefined()
  }
  expect(limits.recheckDue()).toEqual([])
})

test('seen working and then stopped on the same line again, a mark stays limited', () => {
  const { limits } = limitsAt()
  limits.observe('w4:p1', reading())
  limits.noteActivity('w4:p1')
  limits.observe('w4:p1', reading({ status: 'working', line: null }))
  limits.observe('w4:p1', reading())
  expect(limits.due()).toEqual([])
})

test('a resume rejected again after a nudge is marked again: its working and done arrive in one batch', async () => {
  const { limits } = limitsAt()
  const io = fakeIO({ 'w4:p1': SCREEN })
  limits.observe('w4:p1', reading())
  limits.nudge('w4:p1')
  limits.lifted('w4:p1')
  await checkLimits(limits, io, [
    { kind: 'pane.agent_status_changed', session: 's', at: 1, pane_id: 'w4:p1', agent_status: 'working' },
    { kind: 'pane.agent_status_changed', session: 's', at: 2, pane_id: 'w4:p1', agent_status: 'done' },
  ], new Set(['w4:p1']))
  expect(limits.isLimited('w4:p1')).toBe(true)
})

test('a line printed after the pane was seen working is dated as fresh, so a reset just under a day away is tomorrow', () => {
  // A weekly limit hit at 10:05 local that resets at 9:55 tomorrow reads time-only.
  const hit = at('2026-10-11T16:05:00Z')
  const weekly = reading({ line: line('9:55am', 'weekly limit') })
  const undated = limitsAt(hit)
  undated.limits.observe('w4:p1', weekly)
  expect(undated.limits.isLimited('w4:p1')).toBe(false)

  const fresh = limitsAt(hit)
  fresh.limits.noteActivity('w4:p1')
  fresh.limits.observe('w4:p1', weekly)
  expect(fresh.limits.get('w4:p1')?.resetsAt).toBe(at('2026-10-12T15:55:00Z'))
})

test('a new limit line replaces the mark, dated from when it was seen', () => {
  const { limits, clock } = limitsAt()
  limits.observe('w4:p1', reading())
  clock.now = at('2026-10-11T17:00:00Z')
  limits.observe('w4:p1', reading({ line: line('3:20pm') }))
  expect(limits.get('w4:p1')).toMatchObject({ since: clock.now, resetsAt: at('2026-10-11T21:20:00Z') })
})

test('a mark is due at its reset plus the grace, and not before', () => {
  const { limits, clock } = limitsAt()
  limits.observe('w4:p1', reading())
  clock.now = RESET + LIFT_GRACE_MS - 1
  expect(limits.due()).toEqual([])
  clock.now = RESET + LIFT_GRACE_MS
  expect(limits.due()).toEqual(['w4:p1'])
  expect(limits.isLimited('w4:p1')).toBe(true)
})

test('a reset that cannot be read is never due by time, only by moving on or a nudge', () => {
  const { limits, clock } = limitsAt()
  limits.observe('w4:p1', reading({ line: { ...line(), when: null, zone: null } }))
  expect(limits.get('w4:p1')?.resetsAt).toBeNull()
  clock.now += 24 * 3_600_000
  expect(limits.due()).toEqual([])
  limits.nudge('w4:p1')
  expect(limits.due()).toEqual(['w4:p1'])
})

test('a lift by time leaves the line stale: read again unchanged, it is not marked again', () => {
  const { limits, clock } = limitsAt()
  limits.observe('w4:p1', reading())
  clock.now = RESET + LIFT_GRACE_MS
  limits.lifted('w4:p1')
  expect(limits.isLimited('w4:p1')).toBe(false)
  clock.now += 60_000
  limits.observe('w4:p1', reading())
  expect(limits.isLimited('w4:p1')).toBe(false)
})

test('the same text printed again after the pane moved on is a new limit', () => {
  const { limits, clock } = limitsAt()
  limits.observe('w4:p1', reading())
  clock.now = RESET + LIFT_GRACE_MS
  limits.lifted('w4:p1')
  limits.observe('w4:p1', reading({ status: 'working', line: null }))
  // Rejected again a minute later: the 15-minute tolerance dates it to the reset just passed, so it is old.
  clock.now += 60_000
  limits.observe('w4:p1', reading())
  expect(limits.isLimited('w4:p1')).toBe(false)
  // Hours later, in a new window that ends at the same minute tomorrow.
  clock.now = at('2026-10-12T12:00:00Z')
  limits.observe('w4:p1', reading())
  expect(limits.get('w4:p1')?.resetsAt).toBe(at('2026-10-12T16:20:00Z'))
})

test('a lift because the pane moved on leaves nothing stale', () => {
  const { limits } = limitsAt()
  limits.observe('w4:p1', reading())
  limits.observe('w4:p1', movedOn)
  limits.lifted('w4:p1')
  limits.observe('w4:p1', reading())
  expect(limits.isLimited('w4:p1')).toBe(true)
})

test('a nudge on a pane not yet marked keeps its current line from being marked', () => {
  const { limits } = limitsAt()
  limits.nudge('w4:p1')
  limits.observe('w4:p1', reading())
  expect(limits.isLimited('w4:p1')).toBe(false)
  limits.observe('w4:p1', reading({ status: 'working', line: null }))
  limits.observe('w4:p1', reading())
  expect(limits.isLimited('w4:p1')).toBe(true)
})

test('lifting bumps the revision and logs once', () => {
  const { limits, logged } = limitsAt()
  limits.observe('w4:p1', reading())
  const before = limits.revision
  limits.lifted('w4:p1')
  limits.lifted('w4:p1')
  expect(limits.revision).toBe(before + 1)
  expect(logged.filter((m) => m.includes('lifted'))).toHaveLength(1)
})

test('a pane herdr no longer lists is forgotten, unless the list itself failed', () => {
  const { limits } = limitsAt()
  limits.observe('w4:p1', reading())
  limits.forgetGone(new Set())
  expect(limits.isLimited('w4:p1')).toBe(true)
  limits.forgetGone(new Set(['w1:p1']))
  expect(limits.isLimited('w4:p1')).toBe(false)
})

test('a restarted supervisor keeps first sight and the reset, and re-reads every mark at once', () => {
  const { limits, clock } = limitsAt()
  limits.observe('w4:p1', reading())
  limits.observe('w5:p1', reading())
  limits.nudge('w5:p1')
  limits.lifted('w5:p1')

  clock.now = T0 + 3_600_000
  const restarted = new UsageLimits(() => clock.now, () => {}, JSON.parse(JSON.stringify(limits.snapshot())))
  expect(restarted.get('w4:p1')).toMatchObject({ since: T0, resetsAt: RESET })
  expect(restarted.recheckDue()).toEqual(['w4:p1'])
  restarted.observe('w5:p1', reading())
  expect(restarted.isLimited('w5:p1')).toBe(false)
})

test('a pane read within FRESH_MS needs no new read; a marked one is re-read every RECHECK_MS', () => {
  const { limits, clock } = limitsAt()
  limits.observe('w1:p1', movedOn)
  expect(limits.needsRead('w1:p1')).toBe(false)
  clock.now += FRESH_MS
  expect(limits.needsRead('w1:p1')).toBe(true)
  limits.observe('w4:p1', reading())
  expect(limits.needsRead('w4:p1')).toBe(false)
})

const SCREEN = [
  "  ⎿  You've hit your session limit · resets 10:20am (America/Managua)", '',
  '─'.repeat(40), '❯ ', '─'.repeat(40),
].join('\n')

function fakeIO(screens: Record<string, string>, statuses: Record<string, AgentStatus> = {}) {
  const calls: string[] = []
  return {
    calls,
    paneReadStyled: async (pane: string) => { calls.push(`read ${pane}`); return screens[pane] ?? '' },
    agentStatus: async (pane: string) => { calls.push(`status ${pane}`); return statuses[pane] ?? 'done' },
  }
}

test('readLimit reads the screen and status, and a failed read is no reading at all', async () => {
  const io = fakeIO({ 'w4:p1': SCREEN })
  expect(await readLimit(io, 'w4:p1')).toMatchObject({ status: 'done', boxSeen: true, line: { when: '10:20am' } })
  expect(await readLimit(io, 'w9:p1')).toBeNull()
  expect(await readLimit(io, 'w4:p1', 'idle')).toMatchObject({ status: 'idle' })
  expect(io.calls.filter((c) => c.startsWith('status'))).toEqual(['status w4:p1'])
})

test('checkLimits reads panes that went idle or done, re-checks marks, and applies nudges', async () => {
  const { limits, clock } = limitsAt()
  const io = fakeIO({ 'w4:p1': SCREEN, 'w1:p1': SCREEN, 'w6:p1': SCREEN })
  await checkLimits(limits, io, [
    { kind: 'pane.agent_status_changed', session: 's', at: 1, pane_id: 'w4:p1', agent_status: 'working' },
    { kind: 'pane.agent_status_changed', session: 's', at: 2, pane_id: 'w4:p1', agent_status: 'done' },
    { kind: 'pane.agent_status_changed', session: 's', at: 3, pane_id: 'w1:p1', agent_status: 'idle' },
    { kind: 'pane.agent_status_changed', session: 's', at: 4, pane_id: 'w6:p1', agent_status: 'working' },
    { kind: 'pane.agent_status_changed', session: 's', at: 5, pane_id: 'w9:p9', agent_status: 'done' },
  ], new Set(['w4:p1', 'w1:p1', 'w6:p1']))
  expect(limits.isLimited('w4:p1')).toBe(true)
  expect(limits.isLimited('w1:p1')).toBe(true)
  expect(limits.isLimited('w6:p1')).toBe(false)
  expect(io.calls).not.toContain('read w6:p1')
  expect(io.calls).not.toContain('read w9:p9')
  expect(io.calls.filter((c) => c.startsWith('status'))).toEqual([])

  io.calls.length = 0
  clock.now += RECHECK_MS
  await checkLimits(limits, io, [{ kind: 'pipeline.nudge', session: 's', at: 5, pane_id: 'w1:p1' }], new Set())
  expect(io.calls.sort()).toEqual(['read w1:p1', 'read w4:p1', 'status w1:p1', 'status w4:p1'])
  expect(limits.get('w1:p1')?.release).toBe('nudge')
})

test('limitedNow answers from a mark, reads a pane not read lately, and trusts a fresh reading', async () => {
  const { limits, clock } = limitsAt()
  const io = fakeIO({ 'w4:p1': SCREEN, 'w5:p1': SCREEN })
  const limited = limitedNow(limits, io)
  expect(await limited('w4:p1')).toBe(true)
  expect(io.calls).toEqual(['read w4:p1', 'status w4:p1'])
  io.calls.length = 0
  expect(await limited('w4:p1')).toBe(true)
  expect(io.calls).toEqual([])

  limits.observe('w5:p1', reading({ status: 'working', line: null }))
  expect(await limited('w5:p1')).toBe(false)
  expect(io.calls).toEqual([])
  clock.now += FRESH_MS
  expect(await limited('w5:p1')).toBe(true)
})
