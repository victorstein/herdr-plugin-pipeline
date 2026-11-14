import { readSnapshot, type Herdr } from '../kit/herdr'
import { reconcile, stageAgent, StageError, unstage, type Host, type Identity } from '../kit/stage'
import type { PaneInfo, Snapshot } from '../kit/types'
import { readBoards, recordStaged, type StagedWorker, unstageBoard, updateBoards } from '../lib/boards'
import type { Run } from '../lib/types'

export const NO_WORKER = 'no worker to stage'
export const ELSEWHERE = 'that worker is on another stage'
const NOT_RECORDED = 'this board is not recorded yet'
const REPLACED = 'this board has been replaced'

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
 * still holds it. The reverse can happen: an unstage or a teardown that clears the record between
 * the two reads leaves the departed worker in `snap`, and reconcile adopts it as the one stray under
 * the board. That adoption holds no placeholder and heals on the next refresh, once the worker is no
 * longer under the board; nothing here may act on an adopted stage before then.
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

/** Throws StageError with a status-line message. */
export async function stageCard(
  herdr: Herdr, host: Host, identity: Identity, stateDir: string, session: string, slug: string, terminalId: string,
): Promise<StagedWorker> {
  const record = (await readBoards(stateDir, session))[slug]
  if (!record) throw new StageError(NOT_RECORDED)
  if (record.pane_id !== host.boardPaneId) throw new StageError(REPLACED)
  let current = record.staged ?? null
  if (current && current.host.boardPaneId !== host.boardPaneId) {
    await unstageBoard(herdr, stateDir, session, slug)
    current = null
  }
  const staged = await stageAgent(herdr, await readSnapshot(herdr), host, identity, current, terminalId)
  const next: StagedWorker = { ...staged, host }
  // recordStaged only checks that a record exists, and a replacement record would take a stale board's stage
  const recorded = await updateBoards(stateDir, session, (boards) => {
    const board = boards[slug]
    if (!board || board.pane_id !== host.boardPaneId) return false
    board.staged = next
    return true
  })
  if (!recorded) {
    // a stage no record names is invisible to every close path, and a later reconcile would lose its placeholder
    await unstage(herdr, await readSnapshot(herdr), host, next)
    throw new StageError(REPLACED)
  }
  return next
}

/** A board replaced by a newer one quits after it, and must not send the newer board's worker home. */
export async function unstageOwn(herdr: Herdr, stateDir: string, session: string, slug: string, boardPaneId: string | undefined): Promise<void> {
  const record = (await readBoards(stateDir, session))[slug]
  if (!boardPaneId || !record || record.pane_id !== boardPaneId || record.staged?.host.boardPaneId !== boardPaneId) return
  await unstageBoard(herdr, stateDir, session, slug)
}
