import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadHolds, heldBy, holdsBead } from '../src/lib/held'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'held-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeRun(session: string, run: { run_id: string; phase: string; tasks: object[] }): void {
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
