import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'herdr-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('parses a result envelope', async () => {
  const bin = await makeFakeBin(dir, { 'pane list': { result: { panes: [{ pane_id: 'w1:p1' }] } } })
  const panes = await new Herdr(bin).paneList('w1')
  expect(panes[0]?.pane_id).toBe('w1:p1')
})

test('surfaces an error envelope as ok:false with the code', async () => {
  const bin = await makeFakeBin(dir, {
    'agent prompt': { error: { code: 'agent_blocked', message: 'blocked' } },
  })
  const res = await new Herdr(bin).agentPrompt('w1:p1', 'hello')
  expect(res.ok).toBe(false)
  expect(res.code).toBe('agent_blocked')
})

test('treats a zero exit with an error body as failure', async () => {
  const bin = await makeFakeBin(dir, {
    'plugin pane open': { error: { code: 'no_active_workspace', message: 'none' } },
  })
  const res = await new Herdr(bin).pluginPaneOpen('stein.pipeline', 'supervisor', 'w1')
  expect(res.ok).toBe(false)
  expect(res.code).toBe('no_active_workspace')
})

test('records the argv it was called with', async () => {
  const bin = await makeFakeBin(dir, { 'agent get': { result: { agent: { agent_status: 'idle' } } } })
  await new Herdr(bin).agentStatus('w1:p1')
  const log = await Bun.file(join(dir, 'calls.log')).text()
  expect(log).toContain('agent get w1:p1')
})
