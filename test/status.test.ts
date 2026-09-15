import { expect, test } from 'bun:test'
import { formatStatus } from '../src/lib/status'
import { newRun } from '../src/lib/ledger'
import type { Run } from '../src/lib/types'

const mkRun = (): Run =>
  newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })

test('names all four supervisor states', () => {
  for (const state of ['live', 'stale', 'none', 'other-session'] as const) {
    expect(formatStatus([], { state }, 'personal')).toContain(state)
  }
})

test('lists a run with its phase', () => {
  expect(formatStatus([mkRun()], { state: 'live' }, 'personal')).toContain('spec')
})

test('says so plainly when there are no runs', () => {
  expect(formatStatus([], { state: 'live' }, 'personal')).toContain('no active runs')
})

test('warns when the supervisor is not live, because nothing advances then', () => {
  expect(formatStatus([mkRun()], { state: 'none' }, 'personal')).toContain('nothing will advance')
})

test('reports an orchestrator pane that no longer exists', () => {
  const run = mkRun()
  run.orchestrator_pane = 'w4:p9'
  // A genuinely empty set is indistinguishable from "the herdr call failed" and
  // deliberately disables the check (see formatStatus's livePanes.size > 0
  // guard), so this must exercise "gone" with some other pane known live.
  const text = formatStatus([run], { state: 'live' }, 'personal', new Set(['w1:p1']))
  expect(text).toContain('orchestrator pane w4:p9 is gone')
  expect(text).toContain('claim')
})

test('does not warn when the pane is live', () => {
  const run = mkRun()
  run.orchestrator_pane = 'w1:p1'
  const text = formatStatus([run], { state: 'live' }, 'personal', new Set(['w1:p1']))
  expect(text).not.toContain('is gone')
})
