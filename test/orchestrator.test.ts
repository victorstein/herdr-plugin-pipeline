import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'
import { writeOrchestrator } from '../src/lib/ledger'
import { resolveOrchestrator } from '../src/lib/orchestrator'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orch-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('prefers an explicit claim', async () => {
  await writeOrchestrator(dir, 'personal', 'k', {
    pane_id: 'w1:p1', workspace_id: 'w1', socket_path: '/s', claimed_at: 1,
  })
  const bin = await makeFakeBin(dir, { 'pane list': { result: { panes: [{ pane_id: 'w1:p1' }] } } })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBe('w1:p1')
})

test('falls back to the repo primary workspace agent pane', async () => {
  const bin = await makeFakeBin(dir, {
    'workspace list': {
      result: {
        workspaces: [
          { workspace_id: 'w9', label: 'wt', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: true } },
          { workspace_id: 'w1', label: 'main', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: false } },
        ],
      },
    },
    'pane list': { result: { panes: [{ pane_id: 'w1:p1', agent_status: 'idle' }] } },
  })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBe('w1:p1')
})

test('returns null when two agent panes qualify, rather than picking one', async () => {
  const bin = await makeFakeBin(dir, {
    'workspace list': {
      result: {
        workspaces: [
          { workspace_id: 'w1', label: 'main', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: false } },
        ],
      },
    },
    'pane list': { result: { panes: [
      { pane_id: 'w1:p1', agent_status: 'idle' },
      { pane_id: 'w1:p2', agent_status: 'working' },
    ] } },
  })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBeNull()
})

test('returns null rather than guessing when nothing resolves', async () => {
  const bin = await makeFakeBin(dir, { 'workspace list': { result: { workspaces: [] } } })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBeNull()
})

test('discards a claimed pane that no longer exists', async () => {
  await writeOrchestrator(dir, 'personal', 'k', {
    pane_id: 'w4:p9', workspace_id: 'w4', socket_path: '/s', claimed_at: 1,
  })
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [] } },
    'workspace list': { result: { workspaces: [] } },
  })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBeNull()
})
