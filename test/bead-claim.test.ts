import { expect, test } from 'bun:test'
import type { BdFailure, BeadDetail, BeadUpdate } from '../src/lib/bd'
import { claimForDispatch } from '../src/lib/bead-claim'

function fakeBd(detail: Partial<BeadDetail>, failures: { show?: BdFailure; claim?: BdFailure } = {}) {
  const calls: string[] = []
  return {
    calls,
    bd: {
      show: async (id: string) => {
        calls.push(`show ${id}`)
        return failures.show ?? { id, title: 't', status: 'open', ...detail }
      },
      update: async (id: string, change: BeadUpdate) => {
        calls.push(`update ${id} ${JSON.stringify(change)}`)
        return { ok: true as const }
      },
      claim: async (id: string) => {
        calls.push(`claim ${id}`)
        return failures.claim ?? { ok: true as const }
      },
    },
  }
}

test('an open, unassigned bead is claimed straight away', async () => {
  const { bd, calls } = fakeBd({})
  expect(await claimForDispatch(bd, 'hp-1')).toEqual({ ok: true })
  expect(calls).toEqual(['show hp-1', 'claim hp-1'])
})

test('a bead left blocked, or assigned but open, is put back to open and unassigned before the claim', async () => {
  for (const left of [{ status: 'blocked', assignee: 'hpipe' }, { status: 'open', assignee: 'hpipe' }]) {
    const { bd, calls } = fakeBd(left)
    expect(await claimForDispatch(bd, 'hp-1')).toEqual({ ok: true })
    expect(calls).toEqual(['show hp-1', 'update hp-1 {"status":"open","assignee":""}', 'claim hp-1'])
  }
})

test('a bead hpipe already holds in progress is re-claimed as bd\'s own no-op', async () => {
  const { bd, calls } = fakeBd({ status: 'in_progress', assignee: 'hpipe' })
  expect(await claimForDispatch(bd, 'hp-1')).toEqual({ ok: true })
  expect(calls).toEqual(['show hp-1', 'claim hp-1'])
})

test('a failed show or a refused claim comes back as bd said it', async () => {
  const unreadable = fakeBd({}, { show: { reason: 'busy', error: 'Beads is busy, retry' } })
  expect(await claimForDispatch(unreadable.bd, 'hp-1')).toEqual({ reason: 'busy', error: 'Beads is busy, retry' })
  expect(unreadable.calls).toEqual(['show hp-1'])

  const refused = fakeBd({}, { claim: { reason: 'exit', error: 'hp-1 is already claimed by bob' } })
  expect(await claimForDispatch(refused.bd, 'hp-1')).toEqual({ reason: 'exit', error: 'hp-1 is already claimed by bob' })
})
