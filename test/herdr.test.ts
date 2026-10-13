import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr, liveAgentIn } from '../src/lib/herdr'

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
  expect(await herdr.paneRead('w1:p1', 200, 'recent')).toBe('pane read w1:p1 --source recent --lines 200 --format text')
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

test('liveAgentIn: an agentless or missing pane has no live agent, and an empty list reads as every pane having one', () => {
  const live = liveAgentIn([
    { pane_id: 'w1:p1', agent: 'claude', agent_status: 'working' },
    { pane_id: 'w1:p2', agent: null, agent_status: 'unknown' },
  ])
  expect(live('w1:p1')).toBe(true)
  expect(live('w1:p2')).toBe(false)
  expect(live('w9:p9')).toBe(false)
  expect(liveAgentIn([])('w1:p1')).toBe(true)
})

test('a plugin pane opens with its cwd and env when given them', async () => {
  const bin = await makeFakeBin(dir, { 'plugin pane open': { result: {} } })
  await new Herdr(bin).pluginPaneOpen('stein.pipeline', 'board', 'w1', {
    cwd: '/state/beads/meter-abc123', env: { HPIPE_BEADS_SLUG: 'meter-abc123' },
  })
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe(
    'plugin pane open --plugin stein.pipeline --entrypoint board --workspace w1 --placement tab --no-focus ' +
      '--cwd /state/beads/meter-abc123 --env HPIPE_BEADS_SLUG=meter-abc123',
  )
})

test('an opened plugin pane reports its new pane id', async () => {
  const bin = await makeFakeBin(dir, {
    'plugin pane open': { result: { plugin_pane: { pane: { pane_id: 'w1A:p2', label: 'Board' } }, type: 'plugin_pane_opened' } },
  })
  const opened = await new Herdr(bin).pluginPaneOpen('stein.pipeline', 'board', 'w1A')
  expect(opened.result?.plugin_pane?.pane?.pane_id).toBe('w1A:p2')
})

test('renameTabOf finds the pane\'s tab and renames it, since herdr labels tabs only by number — #2', async () => {
  const bin = await makeFakeBin(dir, {
    'pane get w1:p3': { result: { pane: { pane_id: 'w1:p3', tab_id: 'w1:t2' } } },
    'tab rename': { result: {} },
  })
  expect((await new Herdr(bin).renameTabOf('w1:p3', 'Board: meter abc123')).ok).toBe(true)
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim().split('\n'))
    .toEqual(['pane get w1:p3', 'tab rename w1:t2 Board: meter abc123'])
})

test('renameTabOf renames nothing when the pane cannot be read', async () => {
  const bin = await makeFakeBin(dir, { 'pane get': { error: { code: 'pane_not_found', message: 'gone' } } })
  expect(await new Herdr(bin).renameTabOf('w1:p3', 'Board')).toMatchObject({ ok: false, code: 'pane_not_found' })
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe('pane get w1:p3')
})

test('paneRename renames the pane to the label it is given', async () => {
  const bin = await makeFakeBin(dir, { 'pane rename': { result: {} } })
  expect((await new Herdr(bin).paneRename('w1:p3', 'Board: meter abc123')).ok).toBe(true)
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe('pane rename w1:p3 Board: meter abc123')
})

const LISTED_WORKTREES = {
  result: {
    worktrees: [
      { branch: 'main', is_bare: false, is_detached: false, is_linked_worktree: false, is_prunable: false, label: 'r', path: '/r' },
      { branch: 'feat/x', is_bare: false, is_detached: false, is_linked_worktree: true, is_prunable: false, label: 'x', path: '/wt/x' },
      { branch: null, is_bare: false, is_detached: true, is_linked_worktree: true, is_prunable: true, label: 'd', path: '/wt/d' },
    ],
  },
}

test('worktreeList always names the repo with --cwd and reads .result.worktrees', async () => {
  const bin = await makeFakeBin(dir, { 'worktree list': LISTED_WORKTREES })
  const listed = await new Herdr(bin).worktreeList('/r')
  expect(listed).toEqual({
    ok: true,
    items: [
      { path: '/r', branch: 'main', is_linked_worktree: false, is_prunable: false },
      { path: '/wt/x', branch: 'feat/x', is_linked_worktree: true, is_prunable: false },
      { path: '/wt/d', branch: null, is_linked_worktree: true, is_prunable: true },
    ],
  })
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe('worktree list --cwd /r')
})

test('worktreeList reads a branch given as a full ref by its short name', async () => {
  const bin = await makeFakeBin(dir, {
    'worktree list': { result: { worktrees: [{ branch: 'refs/heads/feat/x', is_linked_worktree: true, is_prunable: false, path: '/wt/x' }] } },
  })
  const listed = await new Herdr(bin).worktreeList('/r')
  expect(listed.ok && listed.items[0]?.branch).toBe('feat/x')
})

test('worktreeList is unreadable on any other shape, and on herdr\'s own error', async () => {
  for (const response of [
    { result: {} },
    { result: { worktrees: 'none' } },
    { result: { worktrees: [{ branch: 'feat/x', is_linked_worktree: true, is_prunable: false }] } },
    { result: { worktrees: [{ branch: 'feat/x', is_linked_worktree: 'yes', is_prunable: false, path: '/wt/x' }] } },
    { result: { worktrees: [{ branch: 7, is_linked_worktree: true, is_prunable: false, path: '/wt/x' }] } },
    { error: { code: 'not_git_worktree', message: 'not a git worktree' } },
  ]) {
    const bin = await makeFakeBin(dir, { 'worktree list': response })
    const listed = await new Herdr(bin).worktreeList('/r')
    expect(listed.ok, JSON.stringify(response)).toBe(false)
  }
  const bin = await makeFakeBin(dir, { 'worktree list': { error: { code: 'not_git_worktree', message: 'nope' } } })
  expect(await new Herdr(bin).worktreeList('/r')).toEqual({ ok: false, reason: 'not_git_worktree — nope' })
})

test('workspaceListing and paneListing tell a failed call from an empty list', async () => {
  const listed = await makeFakeBin(dir, {
    'workspace list': { result: { workspaces: [{ workspace_id: 'w5', label: 'x', worktree: { repo_key: 'k', repo_root: '/wt/x', is_linked_worktree: true } }] } },
    'pane list --workspace w5': { result: { panes: [{ pane_id: 'w5:p1', agent: null, agent_status: 'unknown' }] } },
    'pane list --workspace w6': { result: { panes: [] } },
  })
  const herdr = new Herdr(listed)
  expect(await herdr.workspaceListing()).toEqual({
    ok: true,
    items: [{ workspace_id: 'w5', label: 'x', worktree: { repo_key: 'k', repo_root: '/wt/x', is_linked_worktree: true } }],
  })
  expect(await herdr.paneListing('w5')).toEqual({ ok: true, items: [{ pane_id: 'w5:p1', agent: null, agent_status: 'unknown' }] })
  expect(await herdr.paneListing('w6')).toEqual({ ok: true, items: [] })

  const failing = await makeFakeBin(dir, {
    'workspace list': { error: { code: 'server_unavailable', message: 'down' } },
    'pane list': { result: { panes: [{ agent: 'claude' }] } },
  })
  expect((await new Herdr(failing).workspaceListing()).ok).toBe(false)
  expect((await new Herdr(failing).paneListing('w5')).ok).toBe(false)
})

const CREATED = {
  result: {
    workspace: { workspace_id: 'w5', label: 'feat-x' },
    tab: { tab_id: 'w5:t1' },
    root_pane: { pane_id: 'w5:p1', workspace_id: 'w5' },
    worktree: { path: '/wt/feat-x', branch: 'feat/x' },
  },
}

test('worktreeCreate names the repo with --cwd, never steals focus, and reads the new checkout, workspace and pane', async () => {
  const bin = await makeFakeBin(dir, { 'worktree create': CREATED })
  const created = await new Herdr(bin).worktreeCreate('/r', 'feat/x', 'c0ffee1')
  expect(created).toEqual({ ok: true, result: { workspaceId: 'w5', paneId: 'w5:p1', path: '/wt/feat-x' } })
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim())
    .toBe('worktree create --cwd /r --branch feat/x --base c0ffee1 --no-focus')
})

test('worktreeCreate takes the workspace from the root pane when the response has no workspace object', async () => {
  const bin = await makeFakeBin(dir, {
    'worktree create': { result: { root_pane: { pane_id: 'w5:p1', workspace_id: 'w5' }, worktree: { path: '/wt/feat-x' } } },
  })
  expect(await new Herdr(bin).worktreeCreate('/r', 'feat/x', 'c0ffee1'))
    .toEqual({ ok: true, result: { workspaceId: 'w5', paneId: 'w5:p1', path: '/wt/feat-x' } })
})

test('a create response missing a field, or naming two workspaces, is unreadable rather than guessed at', async () => {
  for (const result of [
    { root_pane: { pane_id: 'w5:p1' }, worktree: { path: '/wt/feat-x' } },
    { workspace: { workspace_id: 'w5' }, worktree: { path: '/wt/feat-x' } },
    { workspace: { workspace_id: 'w5' }, root_pane: { pane_id: 'w5:p1' } },
    { workspace: { workspace_id: 'w5' }, root_pane: { pane_id: 'w6:p1', workspace_id: 'w6' }, worktree: { path: '/wt' } },
  ]) {
    const bin = await makeFakeBin(dir, { 'worktree create': { result } })
    const created = await new Herdr(bin).worktreeCreate('/r', 'feat/x', 'c0ffee1')
    expect(created.ok, JSON.stringify(result)).toBe(false)
    expect(created.code).toBe('unreadable_response')
  }
})

test('worktreeCreate carries herdr\'s refusal through from stderr', async () => {
  const bin = await makeFakeBin(dir, { 'worktree create': { error: { code: 'worktree_exists', message: 'exists' } } })
  expect(await new Herdr(bin).worktreeCreate('/r', 'feat/x', 'c0ffee1'))
    .toEqual({ ok: false, code: 'worktree_exists', message: 'exists' })
})

test('agentStart passes --timeout in milliseconds and the agent\'s own args after --', async () => {
  const bin = await makeFakeBin(dir, { 'agent start': { result: { agent: { pane_id: 'w5:p1' } } } })
  const spawned: number[] = []
  const started = await new Herdr(bin).agentStart({
    name: 'hp-1', kind: 'claude', paneId: 'w5:p1', timeoutMs: 80_000,
    args: ['--dangerously-skip-permissions', '--effort', 'high'],
  }, 90_000, (pid) => spawned.push(pid))
  expect(started.ok).toBe(true)
  expect(spawned).toHaveLength(1)
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe(
    'agent start hp-1 --kind claude --pane w5:p1 --timeout 80000 -- --dangerously-skip-permissions --effort high')
})

test('agentStart reads herdr\'s error from stderr, and a start that outlives its bound times out', async () => {
  const refused = await makeFakeBin(dir, { 'agent start': { error: { code: 'agent_not_ready', message: 'blocked' } } })
  expect(await new Herdr(refused).agentStart({ name: 'hp-1', kind: 'claude', paneId: 'w5:p1', timeoutMs: 80_000, args: [] }, 90_000))
    .toEqual({ ok: false, code: 'agent_not_ready', message: 'blocked' })

  const slow = join(dir, 'slow-bin')
  await Bun.write(slow, '#!/bin/sh\nsleep 5\n')
  chmodSync(slow, 0o755)
  const timedOut = await new Herdr(slow).agentStart({ name: 'hp-1', kind: 'claude', paneId: 'w5:p1', timeoutMs: 80_000, args: [] }, 200)
  expect(timedOut.ok).toBe(false)
  expect(timedOut.code).toBe('timeout')
})

test('agentPane names the pane an agent of that name runs in, and nothing when herdr names none', async () => {
  const bin = await makeFakeBin(dir, {
    'agent get hp-1': { result: { agent: { name: 'hp-1', pane_id: 'w3:p1', agent_status: 'idle' } } },
    'agent get hp-2': { error: { code: 'agent_not_found', message: 'none' } },
  })
  const herdr = new Herdr(bin)
  expect(await herdr.agentPane('hp-1')).toBe('w3:p1')
  expect(await herdr.agentPane('hp-2')).toBeNull()
})
