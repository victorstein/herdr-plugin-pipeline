import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'
import {
  clearStrayPanes, ensureWorkspace, keepCrashTail, linkHpipe, reapGhostPanes, reapSupervisorSiblings, startToolsCheck,
  strayKeepSet,
} from '../src/startup'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

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

test('reapGhostPanes leaves a lone ghost alone rather than destroying the workspace', async () => {
  // Closing a workspace's last pane destroys the workspace, which would take out
  // the workspace the supervisor is about to open into. A lone ghost is harmless
  // until there is something to replace it with; clearStrayPanes removes it once
  // the real supervisor pane exists.
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [{ pane_id: 'w3:p1', label: 'Pipeline supervisor' }] } },
    'pane process-info --pane w3:p1': { result: { process_info: { shell_pid: 111 } } },
    'pane close': { result: {} },
  })
  expect(await reapGhostPanes(new Herdr(bin), 'w3', null)).toEqual([])
})

test('reapGhostPanes never closes the pane it is told to keep, whatever its pid reads — #97', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [
      { pane_id: 'w3:p1', label: 'Pipeline supervisor' },
      { pane_id: 'w3:p2', label: 'Pipeline supervisor' },
    ] } },
    'pane process-info --pane w3:p1': { result: { process_info: { shell_pid: 111 } } },
    'pane process-info --pane w3:p2': { result: { process_info: { shell_pid: 999 } } },
    'pane close': { result: {} },
  })
  expect(await reapGhostPanes(new Herdr(bin), 'w3', 222, 'w3:p2')).toEqual(['w3:p1'])
})

test('a reopened supervisor closes the dead supervisor pane beside it — #97', async () => {
  await Bun.write(join(dir, 'workspace.personal.id'), 'w1')
  const bin = await makeFakeBin(dir, {
    'pane list --workspace w1': { result: { panes: [
      { pane_id: 'w1:p2', label: 'Pipeline supervisor' },
      { pane_id: 'w1:p3', label: 'Pipeline supervisor' },
    ] } },
    'pane process-info --pane w1:p2': { result: { process_info: { shell_pid: 111 } } },
    'pane process-info --pane w1:p3': { result: { process_info: { shell_pid: 222 } } },
    'pane close': { result: {} },
  })
  expect(await reapSupervisorSiblings(new Herdr(bin), dir, 'personal', 'w1:p3', 222)).toEqual(['w1:p2'])
  const calls = await Bun.file(join(dir, 'calls.log')).text()
  expect(calls).toContain('pane close w1:p2')
  expect(calls).not.toContain('pane close w1:p3')
})

test('a supervisor with no recorded pipeline workspace closes nothing — #97', async () => {
  const bin = await makeFakeBin(dir, { 'pane close': { result: {} } })
  expect(await reapSupervisorSiblings(new Herdr(bin), dir, 'personal', 'w1:p3', 222)).toEqual([])
  expect(existsSync(join(dir, 'calls.log'))).toBe(false)
})

test('a crash log that cannot be written never throws out of the reap — #97', async () => {
  const bin = await makeFakeBin(dir, {})
  const logPathIsADirectory = dir
  await expect(keepCrashTail(new Herdr(bin), logPathIsADirectory, 'w1:p2')).resolves.toBeUndefined()
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

test('clearStrayPanes spares a just-opened board and recorded boards, and closes the rest, unrecorded renamed boards too', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [
      { pane_id: 'w3:p1', label: 'Pipeline supervisor' },
      { pane_id: 'w3:p2', label: 'Board' },
      { pane_id: 'w3:p3', label: 'Board: meter abc123' },
      { pane_id: 'w3:p4', label: 'Board: other def456' },
      { pane_id: 'w3:p5', label: null },
    ] } },
    'pane close': { result: {} },
  })
  expect(await clearStrayPanes(new Herdr(bin), 'w3', new Set(['w3:p3']))).toEqual(['w3:p4', 'w3:p5'])
})

test('a tools check that rejects settles as null, so it never surfaces as an unhandled rejection', async () => {
  expect(await startToolsCheck(() => Promise.reject(new Error('spawn failed')))).toBeNull()
})

test('a tools check that resolves passes its result through', async () => {
  const tools = { bd: { state: 'ok' as const, version: '1.3.1' }, bv: { state: 'ok' as const, version: '0.25.2' } }
  expect(await startToolsCheck(async () => tools)).toEqual(tools)
})

const runWith = (phase: Run['phase'], tasks: Pick<Task, 'phase' | 'pane_id'>[]): Run => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: '/code/meter', repoRoot: '/code/meter', title: 'a' })
  run.phase = phase
  run.tasks = tasks as Task[]
  return run
}

test("strayKeepSet keeps board panes, the staged worker and its placeholder, and every unfinished task's pane", () => {
  const staged = {
    terminalId: 't1', paneId: 'w3:p6', homeWorkspaceId: 'w1', homeTabId: 'w1:t1',
    homeTabLabel: 'feat-x', placeholderPaneId: 'w1:p2', title: 'feat-x',
    host: { workspaceId: 'w3', tabId: 'w3:t2', boardPaneId: 'w3:p3' },
  }
  const keep = strayKeepSet(
    {
      'meter-abc123': { pane_id: 'w3:p3', shell_pid: 1, opened_at_ms: 1, staged },
      'other-def456': { pane_id: null, shell_pid: null, opened_at_ms: 1, staged: null },
    },
    [
      runWith('execute', [{ phase: 'implement', pane_id: 'w4:p1' }, { phase: 'done', pane_id: 'w5:p1' }, { phase: 'implement', pane_id: null }]),
      runWith('escalated', [{ phase: 'escalated', pane_id: 'w6:p1' }]),
    ],
  )
  expect([...keep].sort()).toEqual(['w1:p2', 'w3:p3', 'w3:p6', 'w4:p1', 'w6:p1'])
})
