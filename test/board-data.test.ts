import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearedFor, recordCleared, runForSlug } from '../src/board/data'
import { beadsSlug } from '../src/lib/beads-project'
import { readBoards, updateBoards } from '../src/lib/boards'
import { newRun, saveRun } from '../src/lib/ledger'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-data-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const run = (repo: string, title: string, phase: 'execute' | 'escalated' | 'done', at: number) => {
  const r = newRun({ session: 'personal', socketPath: '/s', repoKey: repo, repoRoot: repo, title })
  r.phase = phase
  r.phase_entered_at = at
  return r
}

test('the board shows its repo\'s unfinished run, else its newest finished one, else nothing', async () => {
  await saveRun(dir, run('/code/a', 'old', 'done', 1))
  await saveRun(dir, run('/code/a', 'newer done', 'done', 5))
  await saveRun(dir, run('/code/b', 'other repo', 'execute', 9))
  expect((await runForSlug(dir, 'personal', beadsSlug('/code/a')))?.title).toBe('newer done')
  await saveRun(dir, run('/code/a', 'live', 'execute', 3))
  expect((await runForSlug(dir, 'personal', beadsSlug('/code/a')))?.title).toBe('live')
  expect(await runForSlug(dir, 'personal', beadsSlug('/code/none'))).toBeNull()
})

test('a parked escalated run still counts as unfinished', async () => {
  await saveRun(dir, run('/code/a', 'newer done', 'done', 5))
  await saveRun(dir, run('/code/a', 'parked', 'escalated', 3))
  expect((await runForSlug(dir, 'personal', beadsSlug('/code/a')))?.title).toBe('parked')
})

test('cleared Done cards are kept per board and forgotten when the run changes', async () => {
  const slug = beadsSlug('/code/a')
  await updateBoards(dir, 'personal', (b) => { b[slug] = { pane_id: 'w9:p4', shell_pid: 1, opened_at_ms: 1 } })
  await recordCleared(dir, 'personal', slug, 'r1', 't1')
  await recordCleared(dir, 'personal', slug, 'r1', 't2')
  expect([...clearedFor(await readBoards(dir, 'personal'), slug, 'r1')]).toEqual(['t1', 't2'])
  expect([...clearedFor(await readBoards(dir, 'personal'), slug, 'r2')]).toEqual([])
  await recordCleared(dir, 'personal', slug, 'r2', 't9')
  expect((await readBoards(dir, 'personal'))[slug]?.cleared).toEqual({ run_id: 'r2', tasks: ['t9'] })
})
