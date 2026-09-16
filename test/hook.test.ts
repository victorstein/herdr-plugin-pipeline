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
  // The envelope shape is copied from a live herdr 0.9.0 emission. Feeding the
  // inner object directly is what hid a total event-binding failure: every
  // field read off the envelope is undefined, so nothing ever bound.
  const event = toQueuedEvent('worktree.created', 'personal', JSON.stringify({
    event: 'worktree_created',
    data: {
      type: 'worktree_created',
      workspace: { workspace_id: 'w7', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: true } },
      worktree: { branch: 'feat/x', path: '/r/.worktrees/x' },
    },
  }))
  expect(event).toMatchObject({
    kind: 'worktree.created', workspace_id: 'w7', branch: 'feat/x',
    repo_key: 'k', repo_root: '/r', is_linked_worktree: true,
  })
})

test('maps an agent_status_changed payload', () => {
  const event = toQueuedEvent('pane.agent_status_changed', 'personal', JSON.stringify({
    event: 'pane_agent_status_changed',
    data: { pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'blocked' },
  }))
  expect(event).toMatchObject({ kind: 'pane.agent_status_changed', pane_id: 'w7:p1', agent_status: 'blocked' })
})

test('marks a release on agent_detected', () => {
  const event = toQueuedEvent('pane.agent_detected', 'personal', JSON.stringify({
    event: 'pane_agent_detected',
    data: { pane_id: 'w7:p1', workspace_id: 'w7', released: true },
  }))
  expect(event?.released).toBe(true)
})

test('returns null for unparseable JSON', () => {
  expect(toQueuedEvent('pane.exited', 'personal', 'not json')).toBeNull()
})

test('returns null for JSON that parses to a non-object', () => {
  // JSON.parse("null") succeeds; reading a field off it would throw out of a hook.
  expect(toQueuedEvent('pane.exited', 'personal', 'null')).toBeNull()
  expect(toQueuedEvent('pane.exited', 'personal', '42')).toBeNull()
})

test('an unparseable payload enqueues nothing rather than a phantom entry', async () => {
  const { runHook } = await import('../src/hooks/_hook')
  await runHook('pane.exited', dir, 'personal', 'null')
  expect(await drain(dir)).toHaveLength(0)
})

test('the enqueued event survives a round trip through the queue', async () => {
  const { runHook } = await import('../src/hooks/_hook')
  await runHook('pane.exited', dir, 'personal', JSON.stringify({ pane_id: 'w7:p1', workspace_id: 'w7' }))
  const drained = await drain(dir)
  expect(drained[0]).toMatchObject({ kind: 'pane.exited', pane_id: 'w7:p1' })
})

test('an unwrapped payload still parses, so a shape change fails soft', () => {
  const event = toQueuedEvent('pane.exited', 'personal', JSON.stringify({
    pane_id: 'w7:p1', workspace_id: 'w7',
  }))
  expect(event).toMatchObject({ kind: 'pane.exited', pane_id: 'w7:p1' })
})
