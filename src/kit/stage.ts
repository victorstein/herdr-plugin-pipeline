import { readSnapshot, type Herdr } from './herdr'
import type { PaneInfo, Snapshot } from './types'

export interface Staged {
  terminalId: string
  paneId: string
  homeWorkspaceId: string
  homeTabId: string
  homeTabLabel: string
  placeholderPaneId: string | null
  title: string
}

/** Where the board runs: the stage goes under its pane. */
export interface Host {
  workspaceId: string
  tabId: string
  boardPaneId: string
}

/** The plugin using the kit, so the kit can open that plugin's own placeholder and peek panes. */
export interface Identity {
  pluginId: string
  placeholderEntrypoint: string
  peekEntrypoint: string
  /** Shown by the placeholder: "is on the <stageName> stage". */
  stageName: string
}

// pane.move's ratio is the share the target pane (the board) keeps, so the stage gets the other 75%
export const STAGE_RATIO = 0.25

export class StageError extends Error {}

interface MoveResult {
  move_result: { changed: boolean; reason?: string | null; pane: { pane_id: string } }
}

// A refused move (zoomed tab, same tab) is a success response with changed:false, not an error.
async function move(herdr: Herdr, paneId: string, destination: Record<string, unknown>): Promise<string> {
  const result = await herdr.call<MoveResult>('pane.move', { pane_id: paneId, destination, focus: false })
  if (!result.move_result.changed) throw new StageError(`herdr did not move the pane: ${result.move_result.reason ?? 'no reason given'}`)
  return result.move_result.pane.pane_id
}

const paneOfTerminal = (snap: Snapshot, terminalId: string) => snap.panes.find((p) => p.terminal_id === terminalId)
const paneById = (snap: Snapshot, paneId: string | null) => (paneId === null ? undefined : snap.panes.find((p) => p.pane_id === paneId))

const placeholderOf = (snap: Snapshot, staged: Staged) => {
  const pane = paneById(snap, staged.placeholderPaneId)
  return pane && (pane.agent ?? null) === null ? pane : undefined
}

const titleOf = (snap: Snapshot, pane: PaneInfo) =>
  snap.agents.find((a) => a.terminal_id === pane.terminal_id)?.terminal_title_stripped || pane.label || 'agent'

// only agents count: bootstrap briefly leaves the old board's shell in this tab, and a user may split a shell here
const straysUnder = (snap: Snapshot, host: Host, keepTerminalId: string | null) =>
  snap.panes.filter((p) => p.tab_id === host.tabId && p.pane_id !== host.boardPaneId && p.terminal_id !== keepTerminalId && (p.agent ?? null) !== null)

// The stage holds one pane. Anything else under the board has lost its home (a board that crashed mid-move, or a
// second board that took an agent from this stage and handed it back here), so it gets its own tab in the board's space.
async function evict(herdr: Herdr, snap: Snapshot, host: Host, strays: PaneInfo[]): Promise<void> {
  if (!strays.length) return
  await unzoom(herdr, snap, [host.tabId])
  for (const pane of strays) await move(herdr, pane.pane_id, { type: 'new_tab', workspace_id: host.workspaceId, label: titleOf(snap, pane) })
}

function adopt(snap: Snapshot, host: Host, pane: PaneInfo): Staged {
  const title = titleOf(snap, pane)
  return { terminalId: pane.terminal_id, paneId: pane.pane_id, homeWorkspaceId: host.workspaceId, homeTabId: host.tabId, homeTabLabel: title, placeholderPaneId: null, title }
}

async function unzoom(herdr: Herdr, snap: Snapshot, tabIds: string[]): Promise<void> {
  for (const layout of snap.layouts) {
    if (layout.zoomed && tabIds.includes(layout.tab_id)) await herdr.call('pane.zoom', { pane_id: layout.focused_pane_id, mode: 'off' })
  }
}

export async function unstage(herdr: Herdr, snap: Snapshot, host: Host, staged: Staged): Promise<null> {
  const pane = paneOfTerminal(snap, staged.terminalId)
  const placeholder = placeholderOf(snap, staged)
  if (!pane || pane.tab_id !== host.tabId) {
    if (placeholder) await herdr.call('pane.close', { pane_id: placeholder.pane_id })
    return null
  }
  await unzoom(herdr, snap, [host.tabId, ...(placeholder ? [placeholder.tab_id] : [])])
  if (placeholder) {
    await move(herdr, pane.pane_id, { type: 'tab', tab_id: placeholder.tab_id, target_pane_id: placeholder.pane_id, split: 'right' })
    await herdr.call('pane.close', { pane_id: placeholder.pane_id })
  } else if (snap.workspaces.some((w) => w.workspace_id === staged.homeWorkspaceId)) {
    await move(herdr, pane.pane_id, { type: 'new_tab', workspace_id: staged.homeWorkspaceId, label: staged.homeTabLabel })
  } else {
    // A closed home may be a removed pipeline worktree, so it is never recreated.
    await move(herdr, pane.pane_id, { type: 'new_tab', workspace_id: host.workspaceId, label: staged.title })
  }
  return null
}

export async function stageAgent(herdr: Herdr, snap: Snapshot, host: Host, identity: Identity, current: Staged | null, terminalId: string): Promise<Staged> {
  if (current?.terminalId === terminalId) return current
  const target = paneOfTerminal(snap, terminalId)
  if (!target) throw new StageError('that agent is gone')
  if (target.tab_id === host.tabId) throw new StageError('that agent is already under the board')

  let view = snap
  if (current) {
    await unstage(herdr, snap, host, current)
    view = await readSnapshot(herdr)
  }
  const strays = straysUnder(view, host, null)
  if (strays.length) {
    await evict(herdr, view, host, strays)
    view = await readSnapshot(herdr)
  }
  const agentPane = paneOfTerminal(view, terminalId)
  if (!agentPane) throw new StageError('that agent is gone')
  await unzoom(herdr, view, [host.tabId, agentPane.tab_id])
  const homeTabLabel = view.tabs.find((t) => t.tab_id === agentPane.tab_id)?.label ?? ''
  const title = view.agents.find((a) => a.terminal_id === terminalId)?.terminal_title_stripped || homeTabLabel

  const opened = await herdr.call<{ plugin_pane: { pane: { pane_id: string } } }>('plugin.pane.open', {
    plugin_id: identity.pluginId,
    entrypoint: identity.placeholderEntrypoint,
    placement: 'split',
    target_pane_id: agentPane.pane_id,
    direction: 'right',
    focus: false,
    env: { KIT_TITLE: title, KIT_STAGE: identity.stageName },
  })
  const placeholderPaneId = opened.plugin_pane.pane.pane_id
  let paneId: string
  try {
    paneId = await move(herdr, agentPane.pane_id, { type: 'tab', tab_id: host.tabId, target_pane_id: host.boardPaneId, split: 'down', ratio: STAGE_RATIO })
  } catch (err) {
    await herdr.call('pane.close', { pane_id: placeholderPaneId })
    throw err
  }
  return {
    terminalId,
    paneId,
    homeWorkspaceId: agentPane.workspace_id,
    homeTabId: agentPane.tab_id,
    homeTabLabel,
    placeholderPaneId,
    title,
  }
}

export async function reconcile(herdr: Herdr, snap: Snapshot, host: Host, staged: Staged | null): Promise<Staged | null> {
  const kept = await keepStaged(herdr, snap, host, staged)
  const strays = straysUnder(snap, host, kept?.terminalId ?? null)
  if (!kept && strays.length === 1) return adopt(snap, host, strays[0]!)
  await evict(herdr, snap, host, strays)
  return kept
}

async function keepStaged(herdr: Herdr, snap: Snapshot, host: Host, staged: Staged | null): Promise<Staged | null> {
  if (!staged) return null
  const byTerminal = paneOfTerminal(snap, staged.terminalId)
  // After a herdr restart terminal ids change but pane ids survive.
  const found = byTerminal ?? paneById(snap, staged.paneId)
  if (found?.tab_id === host.tabId) return { ...staged, paneId: found.pane_id, terminalId: found.terminal_id }
  const placeholder = placeholderOf(snap, staged)
  if (placeholder) await herdr.call('pane.close', { pane_id: placeholder.pane_id })
  return null
}
