import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEALTH_MAX_AGE_MS, observePanes, readPaneHolds, writeDeliveryHealth } from '../src/lib/delivery-health'
import { paneHasNoAgent } from '../src/lib/herdr'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const HOLD = { since: 1, failures: 3, code: 'agent_not_found' }

test('status reads the holds the live supervisor wrote', async () => {
  await writeDeliveryHealth(dir, 'personal', { pid: 42, written_at: Date.now(), panes: { 'w1:p1': HOLD } })
  expect(await readPaneHolds(dir, 'personal', 42)).toEqual({ 'w1:p1': HOLD })
})

test('a file another supervisor wrote, or no live supervisor at all, reads as holding nothing', async () => {
  await writeDeliveryHealth(dir, 'personal', { pid: 42, written_at: Date.now(), panes: { 'w1:p1': HOLD } })
  expect(await readPaneHolds(dir, 'personal', 43)).toEqual({})
  expect(await readPaneHolds(dir, 'personal', undefined)).toEqual({})
  expect(await readPaneHolds(dir, 'other', 42)).toEqual({})
})

test('a listed pane with no agent is told apart from one running an agent — F5', () => {
  expect(paneHasNoAgent({ pane_id: 'w2:p1', agent: null, agent_status: 'unknown' })).toBe(true)
  expect(paneHasNoAgent({ pane_id: 'w2:p1', agent: 'claude', agent_status: 'idle' })).toBe(false)
  expect(paneHasNoAgent({ pane_id: 'w2:p1', agent_status: 'working' })).toBe(false)
})

test('one pane list gives status the live panes and the agentless ones', async () => {
  const observed = await observePanes(async () => [
    { pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle' },
    { pane_id: 'w2:p1', agent: null, agent_status: 'unknown' },
  ], dir, 'personal', undefined)
  expect([...observed.livePanes]).toEqual(['w1:p1', 'w2:p1'])
  expect([...(observed.panes.agentless ?? [])]).toEqual(['w2:p1'])
})

test('holds a wedged supervisor stopped refreshing are not reported', async () => {
  await writeDeliveryHealth(dir, 'personal', { pid: 42, written_at: 0, panes: { 'w1:p1': HOLD } })
  expect(await readPaneHolds(dir, 'personal', 42, HEALTH_MAX_AGE_MS)).toEqual({ 'w1:p1': HOLD })
  expect(await readPaneHolds(dir, 'personal', 42, HEALTH_MAX_AGE_MS + 1)).toEqual({})
})
