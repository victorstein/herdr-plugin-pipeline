import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipelineRunsDir, sessionKey, workerPhases } from '../src/kit/phases'
import { newRun, saveRun } from '../src/lib/ledger'
import { sessionKey as hpipeSessionKey } from '../src/lib/session'
import type { Task } from '../src/lib/types'

// Pasture reads these run files to label worker cards; a rename here must fail this, not blank its cards.
let plugins: string
beforeEach(() => { plugins = mkdtempSync(join(tmpdir(), 'plugins-')) })
afterEach(() => { rmSync(plugins, { recursive: true, force: true }) })

test('pasture finds each live worker\'s phase in the run files hpipe writes', async () => {
  const stateDir = join(plugins, 'stein.pipeline')
  mkdirSync(stateDir)
  const run = newRun({ session: 'berean-os', socketPath: '/s', repoKey: '/code/a', repoRoot: '/code/a', title: 'live' })
  run.phase = 'execute'
  run.tasks = [
    { task_id: 't1', pane_id: 'wF:p3', phase: 'pr-review' },
    { task_id: 't2', pane_id: null, phase: 'queued' },
  ] as Task[]
  await saveRun(stateDir, run)
  expect(await workerPhases(pipelineRunsDir(join(plugins, 'stein.pasture'), 'berean-os'))).toEqual({ 'wF:p3': 'pr-review' })
})

test('pasture files runs under the plugin id and session key hpipe uses', () => {
  expect(readFileSync(join(import.meta.dir, '..', 'herdr-plugin.toml'), 'utf8')).toMatch(/^id = "stein\.pipeline"$/m)
  for (const env of [{ HERDR_SESSION: 'named' }, { HERDR_SOCKET_PATH: '/x/sessions/berean-os/herdr.sock' }, {}]) {
    expect(sessionKey(env)).toBe(hpipeSessionKey(env))
  }
})
