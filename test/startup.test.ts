import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'
import { clearStrayPanes, ensureWorkspace, linkHpipe, reapGhostPanes } from '../src/startup'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'startup-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('creates the pipeline workspace and leaves its pane alone', async () => {
  const bin = await makeFakeBin(dir, {
    'workspace list': { result: { workspaces: [] } },
    'workspace create': { result: { workspace: { workspace_id: 'w3', label: 'pipeline' } } },
    'pane list': { result: { panes: [{ pane_id: 'w3:p1' }] } },
    'pane close': { result: {} },
  })
  expect(await ensureWorkspace(new Herdr(bin), dir, 'personal', 'pipeline')).toBe('w3')

  // Closing a freshly created workspace's only pane destroys the workspace, so
  // the stray is cleared after the supervisor exists, not here.
  const calls = await Bun.file(join(dir, 'calls.log')).text()
  expect(calls).not.toContain('pane close')
})

test('clearStrayPanes keeps the supervisor and closes the rest', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [
      { pane_id: 'w3:p1', label: null },
      { pane_id: 'w3:p2', label: 'Pipeline supervisor' },
    ] } },
    'pane close': { result: {} },
  })
  expect(await clearStrayPanes(new Herdr(bin), 'w3')).toEqual(['w3:p1'])
})

test('clearStrayPanes closes nothing when only the supervisor is present', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [{ pane_id: 'w3:p2', label: 'Pipeline supervisor' }] } },
    'pane close': { result: {} },
  })
  expect(await clearStrayPanes(new Herdr(bin), 'w3')).toEqual([])
})

test('reuses a recorded workspace id over a label match', async () => {
  await Bun.write(join(dir, 'workspace.personal.id'), 'w5')
  const bin = await makeFakeBin(dir, {
    'workspace list': { result: { workspaces: [
      { workspace_id: 'w5', label: 'renamed' },
      { workspace_id: 'w8', label: 'pipeline' },
    ] } },
  })
  expect(await ensureWorkspace(new Herdr(bin), dir, 'personal', 'pipeline')).toBe('w5')
})

test('closes a ghost supervisor pane whose shell_pid is not the live pane_pid', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [
      { pane_id: 'w3:p1', label: 'Pipeline supervisor' },
      { pane_id: 'w3:p2', label: 'Pipeline supervisor' },
    ] } },
    'pane process-info --pane w3:p1': { result: { process_info: { shell_pid: 111 } } },
    'pane process-info --pane w3:p2': { result: { process_info: { shell_pid: 222 } } },
    'pane close': { result: {} },
  })
  const closed = await reapGhostPanes(new Herdr(bin), 'w3', 222)
  expect(closed).toEqual(['w3:p1'])
})

test('linkHpipe creates the symlink and replaces a stale one', async () => {
  const target = join(dir, 'cli.ts')
  await Bun.write(target, '#!/usr/bin/env bun\n')
  const link = join(dir, 'bin', 'hpipe')

  await linkHpipe(target, link)
  expect(existsSync(link)).toBe(true)

  rmSync(link)
  symlinkSync(join(dir, 'gone.ts'), link)
  await linkHpipe(target, link)
  expect(await Bun.file(link).text()).toContain('#!/usr/bin/env bun')
})
