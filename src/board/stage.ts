import type { Herdr } from '../kit/herdr'
import { reconcile, type Host } from '../kit/stage'
import type { PaneInfo, Snapshot } from '../kit/types'
import { readBoards, recordStaged, type StagedWorker, unstageBoard } from '../lib/boards'
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

/**
 * `snap` must be the one the caller read before this reads the record: teardown clears the record
 * and then closes the worker, so an older snapshot can never show the worker gone while the record
 * still holds it.
 */
export async function syncStage(
  herdr: Herdr, snap: Snapshot, host: Host, stateDir: string, session: string, slug: string,
): Promise<StagedWorker | null> {
  const record = (await readBoards(stateDir, session))[slug]
  // a replaced board must not touch the stage its successor may hold
  if (!record || record.pane_id !== host.boardPaneId) return null
  const recorded = record.staged ?? null
  if (recorded && recorded.host.boardPaneId !== host.boardPaneId) {
    await unstageBoard(herdr, stateDir, session, slug)
    return null
  }
  const kept = await reconcile(herdr, snap, host, recorded)
  const next = kept ? { ...kept, host } : null
  if (JSON.stringify(next) !== JSON.stringify(recorded)) await recordStaged(stateDir, session, slug, next, recorded)
  return next
}
