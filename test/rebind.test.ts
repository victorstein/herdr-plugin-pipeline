import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'
import { newRun } from '../src/lib/ledger'
import { rebindOrchestrator } from '../src/lib/orchestrator'
import type { Run } from '../src/lib/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rebind-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function mkRun(pane: string | null): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: '/r', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = pane
  return run
}

test('a live pane is left alone and costs no resolution', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [{ pane_id: 'w1:p1', agent_status: 'idle' }] } },
  })
  const run = mkRun('w1:p1')
  expect(await rebindOrchestrator(dir, new Herdr(bin), 'personal', run)).toBe(false)
  expect(run.orchestrator_pane).toBe('w1:p1')
})

test('a stale pane is rebound from repo provenance', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list --workspace w1': { result: { panes: [{ pane_id: 'w1:p7', agent_status: 'idle' }] } },
    'pane list': { result: { panes: [{ pane_id: 'w1:p7', agent_status: 'idle' }] } },
    'workspace list': {
      result: {
        workspaces: [
          { workspace_id: 'w1', label: 'main', worktree: { repo_key: 'opaque', repo_root: '/r', is_linked_worktree: false } },
        ],
      },
    },
  })
  const run = mkRun('w1:p1')
  expect(await rebindOrchestrator(dir, new Herdr(bin), 'personal', run)).toBe(true)
  expect(run.orchestrator_pane).toBe('w1:p7')
  expect(run.history.at(-1)?.why).toContain('rebound')
})

test('an unresolvable orchestrator is left untouched rather than cleared', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [] } },
    'workspace list': { result: { workspaces: [] } },
  })
  const run = mkRun('w1:p1')
  expect(await rebindOrchestrator(dir, new Herdr(bin), 'personal', run)).toBe(false)
  // Keeping the stale id preserves the diagnostic `hpipe status` prints.
  expect(run.orchestrator_pane).toBe('w1:p1')
})

test('a run with no orchestrator at all can acquire one', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list --workspace w1': { result: { panes: [{ pane_id: 'w1:p3', agent_status: 'idle' }] } },
    'pane list': { result: { panes: [{ pane_id: 'w1:p3', agent_status: 'idle' }] } },
    'workspace list': {
      result: {
        workspaces: [
          { workspace_id: 'w1', label: 'main', worktree: { repo_key: 'opaque', repo_root: '/r', is_linked_worktree: false } },
        ],
      },
    },
  })
  const run = mkRun(null)
  expect(await rebindOrchestrator(dir, new Herdr(bin), 'personal', run)).toBe(true)
  expect(run.orchestrator_pane).toBe('w1:p3')
})
