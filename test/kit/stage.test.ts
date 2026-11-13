import { describe, expect, test } from 'bun:test'
import { reconcile, stageAgent, unstage, type Host, type Identity, type Staged } from '../../src/kit/stage'
import type { Snapshot } from '../../src/kit/types'
import { fakeHerdr, moved, opened } from './fake-herdr'
import { agent, snapshot } from './fixtures'

const host: Host = { workspaceId: 'wP', tabId: 'wP:t1', boardPaneId: 'wP:p1' }
const GENERAL = { workspace_id: 'w1', label: 'General', active_tab_id: 'w1:t1' }
const identity: Identity = { pluginId: 'stein.example', placeholderEntrypoint: 'placeholder', peekEntrypoint: 'peek', stageName: 'example' }
const BOARD_SPACE = { workspace_id: 'wP', label: 'board', active_tab_id: 'wP:t1' }

function atHome(extra: Partial<Snapshot> = {}): Snapshot {
  return snapshot([agent({ terminal_id: 't1', pane_id: 'w1:p1', terminal_title_stripped: 'RSVP API' })], {
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'rsvp-api' }],
    workspaces: [GENERAL, BOARD_SPACE],
    ...extra,
  })
}

const staged: Staged = {
  terminalId: 't1', paneId: 'wP:p2', homeWorkspaceId: 'w1', homeTabId: 'w1:t1',
  homeTabLabel: 'rsvp-api', placeholderPaneId: 'w1:p2', title: 'RSVP API',
}

function onStage(workspaces = [GENERAL, BOARD_SPACE], withPlaceholder = true): Snapshot {
  const snap = snapshot([agent({ terminal_id: 't1', pane_id: 'wP:p2', tab_id: 'wP:t1', workspace_id: 'wP' })], { workspaces })
  if (withPlaceholder) snap.panes.push({ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'tph', agent: null, agent_status: 'unknown' })
  return snap
}

describe('stageAgent', () => {
  test('leaves a placeholder in the home tab and moves the agent under the board', async () => {
    const { herdr, calls } = fakeHerdr({ 'plugin.pane.open': () => opened('w1:p2'), 'pane.move': () => moved('wP:p2') })
    const result = await stageAgent(herdr, atHome(), host, identity, null, 't1')
    expect(calls[0]).toEqual({
      method: 'plugin.pane.open',
      params: { plugin_id: 'stein.example', entrypoint: 'placeholder', placement: 'split', target_pane_id: 'w1:p1', direction: 'right', focus: false, env: { KIT_TITLE: 'RSVP API', KIT_STAGE: 'example' } },
    })
    expect(calls[1]).toEqual({
      method: 'pane.move',
      params: { pane_id: 'w1:p1', destination: { type: 'tab', tab_id: 'wP:t1', target_pane_id: 'wP:p1', split: 'down', ratio: 0.25 }, focus: false },
    })
    expect(result).toEqual(staged)
  })

  test('a move herdr refuses closes the placeholder and fails', async () => {
    const { herdr, methods } = fakeHerdr({
      'plugin.pane.open': () => opened('w1:p2'),
      'pane.move': () => moved('w1:p1', false, 'zoomed_tab'),
      'pane.close': () => ({ type: 'ok' }),
    })
    await expect(stageAgent(herdr, atHome(), host, identity, null, 't1')).rejects.toThrow('zoomed_tab')
    expect(methods()).toEqual(['plugin.pane.open', 'pane.move', 'pane.close'])
  })

  test('zoomed tabs are un-zoomed before anything moves', async () => {
    const snap = atHome({ layouts: [{ tab_id: 'w1:t1', workspace_id: 'w1', zoomed: true, focused_pane_id: 'w1:p1' }] })
    const { herdr, calls } = fakeHerdr({ 'pane.zoom': () => ({}), 'plugin.pane.open': () => opened('w1:p2'), 'pane.move': () => moved('wP:p2') })
    await stageAgent(herdr, snap, host, identity, null, 't1')
    expect(calls[0]).toEqual({ method: 'pane.zoom', params: { pane_id: 'w1:p1', mode: 'off' } })
  })

  test('staging the agent already on stage does nothing', async () => {
    const { herdr, calls } = fakeHerdr({})
    expect(await stageAgent(herdr, onStage(), host, identity, staged, 't1')).toBe(staged)
    expect(calls).toEqual([])
  })

  test('replacing the staged agent returns it home first', async () => {
    const two = onStage()
    two.agents.push(agent({ terminal_id: 't2', pane_id: 'w1:p5', terminal_title_stripped: 'Docs' }))
    two.panes.push({ pane_id: 'w1:p5', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 't2', agent: 'claude', agent_status: 'idle' })
    const home = atHome({ workspaces: [GENERAL, BOARD_SPACE] })
    home.agents.push(agent({ terminal_id: 't2', pane_id: 'w1:p5', terminal_title_stripped: 'Docs' }))
    home.panes.push({ pane_id: 'w1:p5', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 't2', agent: 'claude', agent_status: 'idle' })
    const { herdr, methods } = fakeHerdr({
      'pane.move': (p) => moved(p.pane_id === 'wP:p2' ? 'w1:p3' : 'wP:p4'),
      'pane.close': () => ({ type: 'ok' }),
      'session.snapshot': () => ({ snapshot: home }),
      'plugin.pane.open': () => opened('w1:p6'),
    })
    const result = await stageAgent(herdr, two, host, identity, staged, 't2')
    expect(methods()).toEqual(['pane.move', 'pane.close', 'session.snapshot', 'plugin.pane.open', 'pane.move'])
    expect(result?.terminalId).toBe('t2')
  })
})

describe('unstage', () => {
  test('returns next to the placeholder, then closes it', async () => {
    const { herdr, calls } = fakeHerdr({ 'pane.move': () => moved('w1:p3'), 'pane.close': () => ({ type: 'ok' }) })
    await unstage(herdr, onStage(), host, staged)
    expect(calls).toEqual([
      { method: 'pane.move', params: { pane_id: 'wP:p2', destination: { type: 'tab', tab_id: 'w1:t1', target_pane_id: 'w1:p2', split: 'right' }, focus: false } },
      { method: 'pane.close', params: { pane_id: 'w1:p2' } },
    ])
  })

  test('without a placeholder it returns as a new tab with the saved label', async () => {
    const { herdr, calls } = fakeHerdr({ 'pane.move': () => moved('w1:p3') })
    await unstage(herdr, onStage([GENERAL, BOARD_SPACE], false), host, staged)
    expect(calls[0]!.params.destination).toEqual({ type: 'new_tab', workspace_id: 'w1', label: 'rsvp-api' })
  })

  test('with its home space gone it is parked in the board space', async () => {
    const { herdr, calls } = fakeHerdr({ 'pane.move': () => moved('wP:p3') })
    await unstage(herdr, onStage([BOARD_SPACE], false), host, staged)
    expect(calls[0]!.params.destination).toEqual({ type: 'new_tab', workspace_id: 'wP', label: 'RSVP API' })
  })
})

describe('stage guards', () => {
  test('stageAgent rejects a target that is gone', async () => {
    const { herdr } = fakeHerdr({})
    await expect(stageAgent(herdr, atHome(), host, identity, null, 'nope')).rejects.toThrow('gone')
  })

  test('stageAgent rejects a target already under the board without calling herdr', async () => {
    const { herdr, calls } = fakeHerdr({})
    await expect(stageAgent(herdr, onStage(), host, identity, null, 't1')).rejects.toThrow('already under the board')
    expect(calls).toEqual([])
  })

  test('unstage with the agent already home only closes the placeholder', async () => {
    const { herdr, calls } = fakeHerdr({ 'pane.close': () => ({ type: 'ok' }) })
    await unstage(herdr, atHome({ panes: [...atHome().panes, { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'tph', agent: null, agent_status: 'unknown' }] }), host, staged)
    expect(calls).toEqual([{ method: 'pane.close', params: { pane_id: 'w1:p2' } }])
  })

  test('unstage with the agent gone only closes the placeholder', async () => {
    const snap = snapshot([], { workspaces: [GENERAL, BOARD_SPACE] })
    snap.panes.push({ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'tph', agent: null, agent_status: 'unknown' })
    const { herdr, calls } = fakeHerdr({ 'pane.close': () => ({ type: 'ok' }) })
    await unstage(herdr, snap, host, staged)
    expect(calls).toEqual([{ method: 'pane.close', params: { pane_id: 'w1:p2' } }])
  })

  test('unstage un-zooms the board tab before moving', async () => {
    const snap = onStage()
    snap.layouts = [{ tab_id: 'wP:t1', workspace_id: 'wP', zoomed: true, focused_pane_id: 'wP:p2' }]
    const { herdr, methods, calls } = fakeHerdr({ 'pane.zoom': () => ({}), 'pane.move': () => moved('w1:p3'), 'pane.close': () => ({ type: 'ok' }) })
    await unstage(herdr, snap, host, staged)
    expect(methods()).toEqual(['pane.zoom', 'pane.move', 'pane.close'])
    expect(calls[0]!.params).toEqual({ pane_id: 'wP:p2', mode: 'off' })
  })

  test('a recorded placeholder id that now holds an agent is never closed', async () => {
    const snap = snapshot([agent({ terminal_id: 'x', pane_id: 'w1:p2' })], { workspaces: [GENERAL, BOARD_SPACE] })
    const { herdr, calls } = fakeHerdr({})
    expect(await reconcile(herdr, snap, host, staged)).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('reconcile', () => {
  test("an agent outside the board's tab ends the stage and closes the placeholder", async () => {
    const snap = atHome({ panes: [...atHome().panes, { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'tph', agent: null, agent_status: 'unknown' }] })
    const { herdr, calls } = fakeHerdr({ 'pane.close': () => ({ type: 'ok' }) })
    expect(await reconcile(herdr, snap, host, staged)).toBeNull()
    expect(calls).toEqual([{ method: 'pane.close', params: { pane_id: 'w1:p2' } }])
  })

  test('the pane id is refreshed when the agent is still in the board tab', async () => {
    const snap = snapshot([agent({ terminal_id: 't1', pane_id: 'wP:p9', tab_id: 'wP:t1', workspace_id: 'wP' })])
    const { herdr } = fakeHerdr({})
    expect(await reconcile(herdr, snap, host, staged)).toEqual({ ...staged, paneId: 'wP:p9' })
  })

  test('a vanished agent clears the stage and closes its placeholder', async () => {
    const snap = snapshot([], { workspaces: [GENERAL, BOARD_SPACE] })
    snap.panes.push({ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'tph', agent: null, agent_status: 'unknown' })
    const { herdr, calls } = fakeHerdr({ 'pane.close': () => ({ type: 'ok' }) })
    expect(await reconcile(herdr, snap, host, staged)).toBeNull()
    expect(calls).toEqual([{ method: 'pane.close', params: { pane_id: 'w1:p2' } }])
  })

  test('after a restart the staged pane is found again by pane id', async () => {
    const snap = snapshot([agent({ terminal_id: 'fresh', pane_id: 'wP:p2', tab_id: 'wP:t1', workspace_id: 'wP' })])
    const { herdr } = fakeHerdr({})
    expect(await reconcile(herdr, snap, host, staged)).toEqual({ ...staged, terminalId: 'fresh' })
  })
})

describe('stray panes under the board', () => {
  const stray = (snap: Snapshot, terminalId: string, paneId: string, title: string) => {
    snap.agents.push(agent({ terminal_id: terminalId, pane_id: paneId, tab_id: 'wP:t1', workspace_id: 'wP', terminal_title_stripped: title }))
    snap.panes.push({ pane_id: paneId, tab_id: 'wP:t1', workspace_id: 'wP', terminal_id: terminalId, agent: 'claude', agent_status: 'idle' })
    return snap
  }
  const empty = () => snapshot([], { workspaces: [GENERAL, BOARD_SPACE] })

  test('with nothing staged, a lone pane under the board is adopted as the stage', async () => {
    const { herdr, calls } = fakeHerdr({})
    expect(await reconcile(herdr, stray(empty(), 'tB', 'wP:p7', 'BFF workshop'), host, null)).toEqual({
      terminalId: 'tB', paneId: 'wP:p7', homeWorkspaceId: 'wP', homeTabId: 'wP:t1', homeTabLabel: 'BFF workshop', placeholderPaneId: null, title: 'BFF workshop',
    })
    expect(calls).toEqual([])
  })

  test('a pane beside the staged one is sent to its own tab in the board\'s space', async () => {
    const { herdr, calls } = fakeHerdr({ 'pane.move': () => moved('wP:p8') })
    expect(await reconcile(herdr, stray(onStage(), 'tB', 'wP:p7', 'BFF workshop'), host, staged)).toEqual(staged)
    expect(calls).toEqual([
      { method: 'pane.move', params: { pane_id: 'wP:p7', destination: { type: 'new_tab', workspace_id: 'wP', label: 'BFF workshop' }, focus: false } },
    ])
  })

  test('with nothing staged, two strays are both sent away rather than one picked', async () => {
    const { herdr, methods } = fakeHerdr({ 'pane.move': () => moved('wP:p9') })
    const snap = stray(stray(empty(), 'tB', 'wP:p7', 'BFF'), 'tC', 'wP:p8', 'Docs')
    expect(await reconcile(herdr, snap, host, null)).toBeNull()
    expect(methods()).toEqual(['pane.move', 'pane.move'])
  })

  test('the board pane and plain shells are never strays', async () => {
    const snap = empty()
    snap.panes.push({ pane_id: 'wP:p1', tab_id: 'wP:t1', workspace_id: 'wP', terminal_id: 'tboard', agent: null, agent_status: 'unknown' })
    snap.panes.push({ pane_id: 'wP:p6', tab_id: 'wP:t1', workspace_id: 'wP', terminal_id: 'tshell', agent: null, agent_status: 'unknown' })
    const { herdr, calls } = fakeHerdr({})
    expect(await reconcile(herdr, snap, host, null)).toBeNull()
    expect(calls).toEqual([])
  })

  test('staging moves a stray out before the new agent comes in', async () => {
    const snap = stray(atHome(), 'tB', 'wP:p7', 'BFF workshop')
    snap.workspaces = [GENERAL, BOARD_SPACE]
    const { herdr, methods, calls } = fakeHerdr({
      'pane.move': (p) => moved(p.pane_id === 'wP:p7' ? 'wP:p8' : 'wP:p2'),
      'session.snapshot': () => ({ snapshot: atHome() }),
      'plugin.pane.open': () => opened('w1:p2'),
    })
    await stageAgent(herdr, snap, host, identity, null, 't1')
    expect(methods()).toEqual(['pane.move', 'session.snapshot', 'plugin.pane.open', 'pane.move'])
    expect(calls[0]!.params.destination).toEqual({ type: 'new_tab', workspace_id: 'wP', label: 'BFF workshop' })
  })
})
