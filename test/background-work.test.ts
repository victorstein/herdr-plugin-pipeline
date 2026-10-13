import { expect, test } from 'bun:test'
import { backgroundWorkOn } from '../src/lib/background-work'

const RULE = '─'.repeat(60)
const ESC = '\x1b'
const DIM = `${ESC}[2m`
const PINK = `${ESC}[38;2;255;107;128m`
const RESET = `${ESC}[0m`
const STATUS_LINE = '  [Opus 5.5 (1M context)] │ Ctx ██░░░░░░░░ 27% │ 5h ██████░░░░ 61% ~0h24m │ 7d ███████░░░ 79% ~9h34m'

/** A Claude screen: the transcript, the input box, then everything Claude draws below it. */
const claude = (transcript: string[], ...below: string[]) =>
  [...transcript, '', RULE, '❯ ', RULE, ...below].join('\n')

// t3's pane on the berean-os trial run of 2026-10-12, as the orchestrator's `herdr pane read` saw it: idle at
// its prompt, herdr reporting `done`, while its implementer subagent waited on a firmware build.
const T3_WAITING_ON_ITS_BUILD = claude([
  '⏺ Agent "Implement btrial-3 plan" finished · 2m 10s',
  '',
  '⏺ The implementer paused while its firmware build compiles. It resumes on its own when the build finishes, and my commit',
  '  monitor is still armed.',
  '',
  '✻ Cogitated for 2m 27s · done 5:25 PM · 1 shell, 4 monitors still running',
], STATUS_LINE,
'  ⏵⏵ bypass permissions on · 1 shell, 4 monitors · ← 1 agent',
'',
'  ⏺ main',
'  ◯ ui-dev  Waiting on x4pro firmware build                                                   2m 10s · ↓ 112.8k tokens')

test('the trial run\'s t3 pane reads as busy: its shells, its monitors and its subagent', () => {
  expect(backgroundWorkOn(T3_WAITING_ON_ITS_BUILD)).toEqual({
    boxSeen: true, running: ['1 shell', '4 monitors', 'ui-dev subagent'],
  })
})

test('`← 1 agent` is the agents-view hint, which a fresh session shows too: no work', () => {
  const fresh = claude(['✻ Welcome back'], STATUS_LINE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent')
  expect(backgroundWorkOn(fresh)).toEqual({ boxSeen: true, running: [] })
})

test('a subagent the panel lists is work even with nothing in the pill', () => {
  const screen = claude(['⏺ Dispatched the reviewer.'], STATUS_LINE,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent', '',
    '  ⏺ main',
    '  ◯ general-purpose  Grepping issue 31–33 specs and plans                                      9m 52s · ↓ 53.0k tokens')
  expect(backgroundWorkOn(screen).running).toEqual(['general-purpose subagent'])
})

test('every pill Claude Code has been seen to draw, singular and plural, in any permission mode', () => {
  const pills: Array<[string, string[]]> = [
    ['  ⏵⏵ bypass permissions on · 2 shells · ← 1 agent', ['2 shells']],
    ['  ⏵⏵ bypass permissions on · 1 monitor · ← 1 agent', ['1 monitor']],
    ['  ⏵⏵ bypass permissions on · 3 shells, 1 monitor · ← 1 agent', ['3 shells', '1 monitor']],
    ['  ⏵⏵ auto mode on · 1 shell, 2 monitors', ['1 shell', '2 monitors']],
    ['  ? for shortcuts · 2 subagents', ['2 subagents']],
    ['  1 workflow, 1 MCP task · ? for shortcuts', ['1 workflow', '1 MCP task']],
    ['  ⏵⏵ bypass permissions on · 3 background', ['3 background']],
    ['  ⏵⏵ bypass permissions on · 2 tasks', ['2 tasks']],
  ]
  for (const [footer, running] of pills) {
    expect(backgroundWorkOn(claude([], STATUS_LINE, footer)).running, footer).toEqual(running)
  }
})

test('the footer is read through its colours and its dimmed separators', () => {
  const styled = claude([], STATUS_LINE,
    `  ${PINK}⏵⏵ bypass permissions on${RESET}${DIM} · ${RESET}1 shell, 4 monitors${DIM} · ${RESET}← 1 agent${RESET}`)
  expect(backgroundWorkOn(styled).running).toEqual(['1 shell', '4 monitors'])
})

test('only what is drawn below the box counts: the transcript\'s "still running" is history', () => {
  const finished = claude(['✻ Cooked for 54s · done 7:23 AM · 2 shells still running', '⏺ Both builds passed.'],
    STATUS_LINE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent')
  expect(backgroundWorkOn(finished).running).toEqual([])
})

test('a status line that only resembles the pill is not read as one', () => {
  const screen = claude([], '  [Opus] │ 2 shells open │ main', '  ⏵⏵ bypass permissions on (shift+tab to cycle)')
  expect(backgroundWorkOn(screen).running).toEqual([])
})

test('a screen with no input box says nothing either way', () => {
  expect(backgroundWorkOn('Do you want to proceed?\n❯ 1. Yes\n  2. No\n  ⏵⏵ bypass permissions on · 1 shell'))
    .toEqual({ boxSeen: false, running: [] })
  expect(backgroundWorkOn('')).toEqual({ boxSeen: false, running: [] })
})
