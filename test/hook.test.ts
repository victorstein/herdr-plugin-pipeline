import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drain } from '../src/lib/queue'
import { toQueuedEvent } from '../src/hooks/_hook'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hook-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('maps a worktree.created payload', () => {
  const event = toQueuedEvent('worktree.created', 'personal', JSON.stringify({
    type: 'worktree_created',
    workspace: { workspace_id: 'w7', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: true } },
    worktree: { branch: 'feat/x', path: '/r/.worktrees/x' },
  }))
  expect(event).toMatchObject({
    kind: 'worktree.created', workspace_id: 'w7', branch: 'feat/x',
    repo_key: 'k', repo_root: '/r', is_linked_worktree: true,
  })
})

test('maps an agent_status_changed payload', () => {
  const event = toQueuedEvent('pane.agent_status_changed', 'personal', JSON.stringify({
    pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'blocked',
  }))
  expect(event).toMatchObject({ kind: 'pane.agent_status_changed', pane_id: 'w7:p1', agent_status: 'blocked' })
})

test('marks a release on agent_detected', () => {
  const event = toQueuedEvent('pane.agent_detected', 'personal', JSON.stringify({
    pane_id: 'w7:p1', workspace_id: 'w7', released: true,
  }))
  expect(event.released).toBe(true)
})

test('returns null-ish safe event for unparseable JSON', () => {
  const event = toQueuedEvent('pane.exited', 'personal', 'not json')
  expect(event.kind).toBe('pane.exited')
  expect(event.pane_id).toBeUndefined()
})

test('the enqueued event survives a round trip through the queue', async () => {
  const { runHook } = await import('../src/hooks/_hook')
  await runHook('pane.exited', dir, 'personal', JSON.stringify({ pane_id: 'w7:p1', workspace_id: 'w7' }))
  const drained = await drain(dir)
  expect(drained[0]).toMatchObject({ kind: 'pane.exited', pane_id: 'w7:p1' })
})
