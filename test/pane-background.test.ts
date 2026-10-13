import { expect, test } from 'bun:test'
import type { QueuedEvent } from '../src/lib/types'
import {
  BACKGROUND_RECHECK_MS, PANEL_RECHECK_MS, PaneBackground, SUBAGENT_HOLD_MAX_MS, SubagentHolds,
} from '../src/supervisor/pane-background'

const RULE = '─'.repeat(40)
const screen = (footer: string) => ['⏺ Done for now.', '', RULE, '❯ ', RULE, footer].join('\n')
const BUSY = screen('  ⏵⏵ bypass permissions on · 1 shell, 4 monitors · ← 1 agent')
const QUIET = screen('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent')
const DIALOG = 'Do you want to proceed?\n❯ 1. Yes\n  2. No'

function reader(screens: Record<string, string>) {
  const reads: string[] = []
  return {
    reads,
    io: { paneReadStyled: async (pane: string) => { reads.push(pane); return screens[pane] ?? '' } },
  }
}

const working = (pane: string): QueuedEvent =>
  ({ kind: 'pane.agent_status_changed', session: 's', at: 0, pane_id: pane, agent_status: 'working' })

test('a pane read through it answers from that reading, with no read of its own', async () => {
  const background = new PaneBackground(() => 0)
  const { io, reads } = reader({ 'w3:p1': BUSY })
  expect(background.observe('w3:p1', BUSY)).toBe(BUSY)
  expect((await background.work('w3:p1', io)).running).toEqual(['1 shell', '4 monitors'])
  expect(background.lastSeen('w3:p1').running).toEqual(['1 shell', '4 monitors'])
  expect(reads).toEqual([])
})

test('a pane never read is read once, and a quiet one is not read again', async () => {
  const background = new PaneBackground(() => 0)
  const { io, reads } = reader({ 'w3:p1': QUIET })
  expect((await background.work('w3:p1', io)).running).toEqual([])
  expect((await background.work('w3:p1', io)).running).toEqual([])
  expect(reads).toEqual(['w3:p1'])
})

test('work that may have ended without a turn is read again once its reading is old', async () => {
  const clock = { now: 0 }
  const background = new PaneBackground(() => clock.now)
  const screens: Record<string, string> = { 'w3:p1': BUSY }
  const { io, reads } = reader(screens)
  background.observe('w3:p1', BUSY)
  clock.now = BACKGROUND_RECHECK_MS - 1
  expect((await background.work('w3:p1', io)).running).toEqual(['1 shell', '4 monitors'])
  screens['w3:p1'] = QUIET
  clock.now = BACKGROUND_RECHECK_MS
  expect((await background.work('w3:p1', io)).running).toEqual([])
  expect(reads).toEqual(['w3:p1'])
})

test('a screen with no input box is no answer: it is not trusted, and read again only after the recheck', async () => {
  const clock = { now: 0 }
  const background = new PaneBackground(() => clock.now)
  const screens: Record<string, string> = { 'w3:p1': DIALOG }
  const { io, reads } = reader(screens)
  expect((await background.work('w3:p1', io)).running).toEqual([])
  expect((await background.work('w3:p1', io)).running).toEqual([])
  expect(reads).toHaveLength(1)
  screens['w3:p1'] = BUSY
  clock.now = BACKGROUND_RECHECK_MS
  expect((await background.work('w3:p1', io)).running).toEqual(['1 shell', '4 monitors'])
})

test('a dialog read later does not wipe out the work last seen', () => {
  const background = new PaneBackground(() => 0)
  background.observe('w3:p1', BUSY)
  background.observe('w3:p1', DIALOG)
  expect(background.lastSeen('w3:p1').running).toEqual(['1 shell', '4 monitors'])
})

test('a turn starting forgets the reading, so the next idle is read afresh', async () => {
  const background = new PaneBackground(() => 0)
  const { io, reads } = reader({ 'w3:p1': QUIET })
  background.observe('w3:p1', BUSY)
  background.noteTurns([working('w3:p1')])
  expect(background.lastSeen('w3:p1').running).toEqual([])
  expect((await background.work('w3:p1', io)).running).toEqual([])
  expect(reads).toEqual(['w3:p1'])
})

test('a pane gone from the list is forgotten; an empty list is a failed list', () => {
  const background = new PaneBackground(() => 0)
  background.observe('w3:p1', BUSY)
  background.forgetGone(new Set())
  expect(background.lastSeen('w3:p1').running).toHaveLength(2)
  background.forgetGone(new Set(['w1:p1']))
  expect(background.lastSeen('w3:p1').running).toEqual([])
})

test('a subagent holds a row from its first hold until the cap, then lets it advance, naming what it passed', async () => {
  const clock = { now: 0 }
  let subagents = ['ui-dev subagent']
  const holds = new SubagentHolds(async () => subagents, () => clock.now)
  expect(await holds.check('r1:t3:5', 'w5:p1')).toEqual({ hold: true })
  clock.now = SUBAGENT_HOLD_MAX_MS - 1
  expect(await holds.check('r1:t3:5', 'w5:p1')).toEqual({ hold: true })
  clock.now = SUBAGENT_HOLD_MAX_MS
  expect(await holds.check('r1:t3:5', 'w5:p1')).toEqual({ hold: false, past: ['ui-dev subagent'] })

  expect(await holds.check('r1:t3:9', 'w5:p1')).toEqual({ hold: true })
  subagents = []
  expect(await holds.check('r1:t3:9', 'w5:p1')).toEqual({ hold: false })
  subagents = ['ui-dev subagent']
  clock.now += SUBAGENT_HOLD_MAX_MS
  expect(await holds.check('r1:t3:9', 'w5:p1')).toEqual({ hold: true })
})

test('work seen only in the agents panel is read again once a finished subagent would have left it', async () => {
  const clock = { now: 0 }
  const background = new PaneBackground(() => clock.now)
  const lingering = ['⏺ Done.', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on · ← 1 agent', '', '  ⏺ main',
    '  ◯ general-purpose  Reviewed the plan                                       41s · ↓ 20.3k tokens'].join('\n')
  const screens: Record<string, string> = { 'w3:p1': lingering }
  const { io, reads } = reader(screens)
  background.observe('w3:p1', lingering)
  screens['w3:p1'] = QUIET
  clock.now = PANEL_RECHECK_MS - 1
  expect((await background.work('w3:p1', io)).subagents).toEqual(['general-purpose subagent'])
  clock.now = PANEL_RECHECK_MS
  expect((await background.work('w3:p1', io)).running).toEqual([])
  expect(reads).toEqual(['w3:p1'])
})
