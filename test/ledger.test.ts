import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeRunForRepo, listRuns, newRun, readOrchestrator,
  saveRun, writeOrchestrator,
} from '../src/lib/ledger'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('newRun produces a unique suffixed id and spec phase', () => {
  const a = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })
  const b = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })
  expect(a.phase).toBe('spec')
  expect(a.run_id).not.toBe(b.run_id)
  expect(a.run_id).toContain('chat-meter')
})

test('listRuns only returns runs for the requested session', async () => {
  const mine = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  const theirs = newRun({ session: 'default', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'b' })
  await saveRun(dir, mine)
  await saveRun(dir, theirs)

  const runs = await listRuns(dir, 'personal')
  expect(runs).toHaveLength(1)
  expect(runs[0]?.title).toBe('a')
})

test('activeRunForRepo ignores a finished run', async () => {
  const done = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  done.phase = 'done'
  await saveRun(dir, done)
  expect(await activeRunForRepo(dir, 'personal', 'k')).toBeNull()
})

test('activeRunForRepo finds a live run', async () => {
  const live = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  await saveRun(dir, live)
  expect((await activeRunForRepo(dir, 'personal', 'k'))?.run_id).toBe(live.run_id)
})

test('orchestrators are keyed by session and repo', async () => {
  await writeOrchestrator(dir, 'personal', 'k', {
    pane_id: 'w1:p1', workspace_id: 'w1', socket_path: '/s', claimed_at: 1,
  })
  expect((await readOrchestrator(dir, 'personal', 'k'))?.pane_id).toBe('w1:p1')
  expect(await readOrchestrator(dir, 'default', 'k')).toBeNull()
})

test('concurrent orchestrator claims for different repos in one session both persist', async () => {
  await Promise.all([
    writeOrchestrator(dir, 'personal', 'repo-a', {
      pane_id: 'w1:p1', workspace_id: 'w1', socket_path: '/s', claimed_at: 1,
    }),
    writeOrchestrator(dir, 'personal', 'repo-b', {
      pane_id: 'w2:p1', workspace_id: 'w2', socket_path: '/s', claimed_at: 2,
    }),
  ])

  expect((await readOrchestrator(dir, 'personal', 'repo-a'))?.pane_id).toBe('w1:p1')
  expect((await readOrchestrator(dir, 'personal', 'repo-b'))?.pane_id).toBe('w2:p1')
})

test('a new run carries schema_version 2 and an open intake', () => {
  const run = newRun({ session: 's', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  expect(run.schema_version).toBe(2)
  expect(run.intake_closed).toBe(false)
  expect(run.passes).toEqual({})
})
