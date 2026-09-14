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
