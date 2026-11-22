import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipelineRunsDir, sessionKey, workerPhases } from '../../src/kit/phases'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'phases-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const write = (name: string, body: unknown) => writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))

test('live workers map to their phase; finished tasks, torn files and other files are skipped', async () => {
  write('a.json', { phase_entered_at: 1, tasks: [{ pane_id: 'w1:p1', phase: 'implement' }, { pane_id: null, phase: 'done' }] })
  write('b.json', '{"tasks": [')
  write('a.batch-pr.md', 'not a run')
  write('c.json', { other: 'schema' })
  expect(await workerPhases(dir)).toEqual({ 'w1:p1': 'implement' })
})

test('a finished run names no live workers, though it kept their pane ids', async () => {
  write('done.json', { phase: 'done', phase_entered_at: 9, tasks: [{ pane_id: 'w3:p1', phase: 'done' }] })
  expect(await workerPhases(dir)).toEqual({})
})

test('a pane named by two runs takes the newest run\'s phase', async () => {
  write('new.json', { phase_entered_at: 9, tasks: [{ pane_id: 'w1:p1', phase: 'pr-review' }] })
  write('old.json', { phase_entered_at: 1, tasks: [{ pane_id: 'w1:p1', phase: 'implement' }] })
  expect(await workerPhases(dir)).toEqual({ 'w1:p1': 'pr-review' })
})

test('a missing runs directory means no phases', async () => {
  expect(await workerPhases(join(dir, 'none'))).toEqual({})
})

test('the session comes from HERDR_SESSION, else the socket path, else default', () => {
  expect(sessionKey({ HERDR_SESSION: 'named', HERDR_SOCKET_PATH: '/x/sessions/sock/herdr.sock' })).toBe('named')
  expect(sessionKey({ HERDR_SOCKET_PATH: '/x/sessions/berean-os/herdr.sock' })).toBe('berean-os')
  expect(sessionKey({})).toBe('default')
})

test('the runs live beside this plugin\'s state, under stein.pipeline', () => {
  expect(pipelineRunsDir('/s/plugins/stein.pasture', 'berean-os')).toBe('/s/plugins/stein.pipeline/runs/berean-os')
})
