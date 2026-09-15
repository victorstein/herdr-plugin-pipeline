import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStartedAtMs, readPid, supervisorState, writePid } from '../src/lib/pidfile'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pid-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('reports none when no pid file exists', async () => {
  expect((await supervisorState(dir, 'personal')).state).toBe('none')
})

test('reports live for our own running process with a matching start time', async () => {
  await writePid(dir, {
    pid: process.pid, pane_pid: process.ppid, started_at_ms: await processStartedAtMs(process.pid) ?? 0,
    session: 'personal', socket_path: '/s', pane_id: 'w1:p2',
  })
  expect((await supervisorState(dir, 'personal')).state).toBe('live')
})

test('reports stale when the recorded start time does not match the live pid', async () => {
  await writePid(dir, {
    pid: process.pid, pane_pid: process.ppid, started_at_ms: 1,
    session: 'personal', socket_path: '/s', pane_id: 'w1:p2',
  })
  expect((await supervisorState(dir, 'personal')).state).toBe('stale')
})

test('reports stale for a pid that does not exist', async () => {
  await writePid(dir, {
    pid: 999_999, pane_pid: 1, started_at_ms: 1,
    session: 'personal', socket_path: '/s', pane_id: 'w1:p2',
  })
  expect((await supervisorState(dir, 'personal')).state).toBe('stale')
})

test('another session owns its own file and does not collide', async () => {
  await writePid(dir, {
    pid: process.pid, pane_pid: process.ppid, started_at_ms: await processStartedAtMs(process.pid) ?? 0,
    session: 'personal', socket_path: '/s', pane_id: 'w1:p2',
  })
  expect((await supervisorState(dir, 'default')).state).toBe('none')
  expect((await readPid(dir, 'personal'))?.pane_id).toBe('w1:p2')
})
