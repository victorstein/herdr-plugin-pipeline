import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadClaimants, beadHolds, heldBy, holdsBead, phaseHoldsBead } from '../src/lib/held'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'held-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeRun(session: string, run: { run_id: string; phase: string; repo_key?: string; tasks: object[] }): void {
  mkdirSync(join(dir, 'runs', session), { recursive: true })
  writeFileSync(join(dir, 'runs', session, `${run.run_id}.json`), JSON.stringify({ schema_version: 3, ...run }))
}

test('a live task in a live run holds its bead; a finished task, a finished run or no bead does not', () => {
  const live = { phase: 'execute' }
  for (const phase of ['queued', 'research', 'implement', 'merge', 'close', 'escalated', 'blocked-on-decision']) {
    expect(holdsBead(live, { phase, bead: 'hp-1' }), phase).toBe(true)
  }
  for (const phase of ['done', 'failed', 'orphaned', 'blocked-on-failure']) {
    expect(holdsBead(live, { phase, bead: 'hp-1' }), phase).toBe(false)
  }
  expect(holdsBead({ phase: 'done' }, { phase: 'implement', bead: 'hp-1' })).toBe(false)
  expect(holdsBead(live, { phase: 'implement' })).toBe(false)
})

test('phaseHoldsBead is the held predicate on phases alone, for callers whose task always names a bead', () => {
  expect(phaseHoldsBead('execute', 'implement')).toBe(true)
  expect(phaseHoldsBead('execute', 'failed')).toBe(false)
  expect(phaseHoldsBead('execute', 'done')).toBe(false)
  expect(phaseHoldsBead('done', 'implement')).toBe(false)
})

test('every session\'s runs are scanned, and only what is held is returned', async () => {
  writeRun('personal', {
    run_id: 'r1', phase: 'execute',
    tasks: [{ task_id: 't1', phase: 'implement', bead: 'hp-1' }, { task_id: 't2', phase: 'failed', bead: 'hp-2' }],
  })
  writeRun('work', { run_id: 'r2', phase: 'intake', tasks: [{ task_id: 't1', phase: 'queued', bead: 'hp-3' }] })
  writeRun('work', { run_id: 'r3', phase: 'done', tasks: [{ task_id: 't1', phase: 'implement', bead: 'hp-4' }] })
  writeRun('work', { run_id: 'r4', phase: 'execute', tasks: [{ task_id: 't1', phase: 'implement', issue: 7 }] })

  const holds = await beadHolds(dir)
  expect([...holds.keys()].sort()).toEqual(['hp-1', 'hp-3'])
  expect(await heldBy(dir, 'hp-3')).toEqual({ session: 'work', run_id: 'r2', task_id: 't1', phase: 'queued' })
  expect(await heldBy(dir, 'hp-2')).toBeNull()
})

test('no runs directory means nothing is held', async () => {
  expect((await beadHolds(join(dir, 'empty'))).size).toBe(0)
})

test('claimants are every current-schema task naming a bead in any session, held or not', async () => {
  writeRun('personal', {
    run_id: 'r1', phase: 'done', repo_key: '/code/a',
    tasks: [{ task_id: 't1', phase: 'implement', bead: 'hp-1', registered_at: 5 }],
  })
  writeRun('work', { run_id: 'r2', phase: 'execute', repo_key: '/code/a', tasks: [{ task_id: 't1', phase: 'queued', bead: 'hp-1', registered_at: 7 }] })
  mkdirSync(join(dir, 'runs', 'work'), { recursive: true })
  writeFileSync(join(dir, 'runs', 'work', 'old.json'), JSON.stringify({
    schema_version: 2, run_id: 'old', phase: 'execute', repo_key: '/code/a', tasks: [{ task_id: 't1', phase: 'implement', bead: 'hp-1' }],
  }))

  expect(await beadClaimants(dir)).toEqual([
    { session: 'personal', run_id: 'r1', task_id: 't1', repo_key: '/code/a', bead: 'hp-1', holds: false, registered_at: 5 },
    { session: 'work', run_id: 'r2', task_id: 't1', repo_key: '/code/a', bead: 'hp-1', holds: true, registered_at: 7 },
  ])
})
