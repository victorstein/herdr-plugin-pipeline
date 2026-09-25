import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'herdr-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('a pane read is the screen herdr prints, not an envelope, and a failed one is empty', async () => {
  const bin = join(dir, 'screen-bin')
  await Bun.write(bin, [
    '#!/bin/sh',
    'if [ "$3" = "w9:p9" ]; then echo \'{"error":{"code":"pane_not_found","message":"x"}}\'; exit 1; fi',
    'printf "%s" "$*"',
  ].join('\n'))
  chmodSync(bin, 0o755)
  const herdr = new Herdr(bin)
  expect(await herdr.paneRead('w1:p1', 40)).toBe('pane read w1:p1 --source visible --lines 40 --format text')
  expect(await herdr.paneReadStyled('w1:p1', 40)).toBe('pane read w1:p1 --source visible --lines 40 --format ansi')
  expect(await herdr.paneRead('w9:p9', 40)).toBe('')
})

test('parses a result envelope', async () => {
  const bin = await makeFakeBin(dir, { 'pane list': { result: { panes: [{ pane_id: 'w1:p1' }] } } })
  const panes = await new Herdr(bin).paneList('w1')
  expect(panes[0]?.pane_id).toBe('w1:p1')
})

test('surfaces an error envelope from stderr as ok:false with the code', async () => {
  // The fake writes errors the way herdr 0.9.0 does: stderr, exit 1, empty
  // stdout. Reading stdout alone reported every one of them as `unparseable`.
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
  }, { 'plugin pane open': 0 })
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

test('a confirmed prompt waits for the agent to start working, bounded by a timeout', async () => {
  const bin = await makeFakeBin(dir, { 'agent prompt': { result: {} } })
  const res = await new Herdr(bin).agentPromptConfirmed('w1:p1', 'brief', 30000)
  expect(res.ok).toBe(true)
  const log = await Bun.file(join(dir, 'calls.log')).text()
  expect(log).toContain('agent prompt w1:p1 brief --wait --until working --until blocked --timeout 30000')
})

test('send-keys passes logical key names through to the agent', async () => {
  const bin = await makeFakeBin(dir, { 'agent send-keys': { result: {} } })
  const res = await new Herdr(bin).agentSendKeys('w1:p1', ['ctrl+c'])
  expect(res.ok).toBe(true)
  const log = await Bun.file(join(dir, 'calls.log')).text()
  expect(log).toContain('agent send-keys w1:p1 ctrl+c')
})

test('a missing binary returns a failed result instead of throwing', async () => {
  const res = await new Herdr(join(dir, 'no-such-binary')).agentPrompt('w1:p1', 'hello')
  expect(res.ok).toBe(false)
  expect(res.code).toBe('spawn_failed')
})

test('paneShellPid returns undefined when the call fails', async () => {
  const bin = await makeFakeBin(dir, {})
  const pid = await new Herdr(bin).paneShellPid('w1:p1')
  expect(pid).toBeUndefined()
})

test('paneShellPid returns null when herdr answers without a pid', async () => {
  const bin = await makeFakeBin(dir, { 'pane process-info': { result: { process_info: {} } } })
  const pid = await new Herdr(bin).paneShellPid('w1:p1')
  expect(pid).toBeNull()
})

test('fake-bin requires a token boundary after the matched prefix', async () => {
  const bin = await makeFakeBin(dir, {
    'agent get w1:p1': { result: { agent: { agent_status: 'idle' } } },
  })
  const proc = Bun.spawn([bin, 'agent', 'get', 'w1:p10'], { stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stderr).text()
  await proc.exited
  const parsed = JSON.parse(text) as { error?: { code: string } }
  expect(parsed.error?.code).toBe('unstubbed')
})
