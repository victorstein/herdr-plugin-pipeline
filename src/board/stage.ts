import type { Host } from '../kit/stage'
import type { PaneInfo, Snapshot } from '../kit/types'
import type { Run } from '../lib/types'

export const NO_WORKER = 'no worker to stage'
export const ELSEWHERE = 'that worker is on another stage'

export function boardHost(snap: Snapshot, boardPaneId: string | undefined): Host | null {
  const pane = boardPaneId === undefined ? undefined : snap.panes.find((p) => p.pane_id === boardPaneId)
  return pane ? { workspaceId: pane.workspace_id, tabId: pane.tab_id, boardPaneId: pane.pane_id } : null
}

/** The pane to stage for a card, or the status-line text saying why there is none. */
export function workerFor(run: Run | null, snap: Snapshot, host: Host, cardId: string): PaneInfo | string {
  const task = run?.tasks.find((t) => t.task_id === cardId)
  const pane = task?.pane_id ? snap.panes.find((p) => p.pane_id === task.pane_id) : undefined
  if (!run || !task || !pane || pane.pane_id === run.orchestrator_pane) return NO_WORKER
  // A pipeline worker lives in its worktree's workspace; anywhere else, another board staged it and holds its home spot.
  if (pane.workspace_id !== task.workspace_id && pane.tab_id !== host.tabId) return ELSEWHERE
  return pane
}
