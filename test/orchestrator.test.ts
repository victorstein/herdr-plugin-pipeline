import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'
import { listRuns, newRun, saveRun, writeOrchestrator } from '../src/lib/ledger'
import { claimRunForRepo, resolveOrchestrator } from '../src/lib/orchestrator'

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
          { workspace_id: 'w9', label: 'wt', worktree: { repo_key: 'opaque-a', repo_root: '/r', is_linked_worktree: true } },
          { workspace_id: 'w1', label: 'main', worktree: { repo_key: 'opaque-b', repo_root: '/r', is_linked_worktree: false } },
        ],
      },
    },
    'pane list': { result: { panes: [{ pane_id: 'w1:p1', agent_status: 'idle' }] } },
  })
  // Matches on repo_root, a filesystem path, because herdr's repo_key is an
  // opaque herdr identifier while every run record keys off `git rev-parse
  // --show-toplevel`. Comparing those two would never match.
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', '/r')).toBe('w1:p1')
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

// ——— claimRunForRepo ———

async function seedRun(title: string, phase = 'execute'): Promise<string> {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: '/repo', repoRoot: '/repo', title })
  run.phase = phase as typeof run.phase
  await saveRun(dir, run)
  return run.run_id
}

const panes = async () =>
  Object.fromEntries((await listRuns(dir, 'personal')).map((r) => [r.run_id, r.orchestrator_pane]))

test('claim binds the pane to the one run for the repo', async () => {
  const id = await seedRun('a')
  const outcome = await claimRunForRepo(dir, 'personal', '/repo', 'w1:p1', 'hpipe')
  expect(outcome).toEqual({ ok: true, message: `w1:p1 now drives ${id}` })
  expect((await panes())[id]).toBe('w1:p1')
})

test('claim with no run for the repo binds nothing and succeeds', async () => {
  const outcome = await claimRunForRepo(dir, 'personal', '/repo', 'w1:p1', 'hpipe')
  expect(outcome.ok).toBe(true)
  expect(outcome.message).toContain('no active run yet')
})

test('claim refuses to guess between two live runs for the repo', async () => {
  const a = await seedRun('aaa')
  const b = await seedRun('bbb')
  const outcome = await claimRunForRepo(dir, 'personal', '/repo', 'w1:p1', 'hpipe')
  expect(outcome.ok).toBe(false)
  expect(outcome.message).toContain(a)
  expect(outcome.message).toContain(b)
  expect(await panes()).toEqual({ [a]: null, [b]: null })
})

test('claim reads a run in no phase row as occupying the repo, as start does', async () => {
  const broken = await seedRun('broken', 'dnoe')
  const outcome = await claimRunForRepo(dir, 'personal', '/repo', 'w1:p1', 'hpipe')
  expect(outcome.ok).toBe(false)
  expect(outcome.message).toContain(`hpipe rewind ${broken} <phase>`)
  expect((await panes())[broken]).toBeNull()
})
