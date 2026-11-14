import { join } from 'node:path'
import { readJson, withFileLock, writeJson } from './store'
import { readSnapshot, type Herdr } from '../kit/herdr'
import { type Host, type Staged, unstage } from '../kit/stage'
import type { Snapshot } from '../kit/types'

/**
 * `pane_id: null` is a board the supervisor has asked herdr for and not yet
 * heard back about; `shell_pid: null` is one whose `board.ts` has not recorded
 * itself yet. `shell_pid` is how a herdr restart's plain shell, which keeps the
 * label, is told from the board that was there.
 */
export interface BoardRecord {
  pane_id: string | null
  shell_pid: number | null
  opened_at_ms: number
  /** Done cards the user cleared with `x`; only for the run they were cleared in. */
  cleared?: { run_id: string; tasks: string[] }
  staged?: StagedWorker | null
}

/** The host is kept so the stage can still be undone once the board pane that made it is gone. */
export type StagedWorker = Staged & { host: Host }

export type BoardRegistry = Record<string, BoardRecord>

export const BOARD_PANE_TITLE = 'Board'
/** Longer than `board.ts` takes to start and record itself; a board still booting past this never came up. */
export const BOARD_OPEN_GRACE_MS = 30_000
/** A slug is `<repo>-<hash6>`, so its last seven characters are the dash and the hash. */
const SLUG_HASH_SUFFIX = 7

const boardsPath = (stateDir: string, session: string): string => join(stateDir, `boards.${session}.json`)

export function boardLabel(slug: string): string {
  return `${BOARD_PANE_TITLE}: ${slug.slice(0, -SLUG_HASH_SUFFIX)} ${slug.slice(-(SLUG_HASH_SUFFIX - 1))}`
}

/** A board that has started and renamed itself; one still labelled plain `Board` has not got that far. */
export function isRenamedBoardLabel(label: string | null | undefined): boolean {
  return (label ?? '').startsWith(`${BOARD_PANE_TITLE}: `)
}

export function sameBoard(a: BoardRecord | undefined, b: BoardRecord | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.pane_id === b.pane_id && a.shell_pid === b.shell_pid && a.opened_at_ms === b.opened_at_ms
}

export function recordedBoardPanes(boards: BoardRegistry): Set<string> {
  return new Set(Object.values(boards).map((board) => board.pane_id).filter((id): id is string => id !== null))
}

export async function readBoards(stateDir: string, session: string): Promise<BoardRegistry> {
  return (await readJson<BoardRegistry>(boardsPath(stateDir, session))) ?? {}
}

/** The supervisor and each board's own process both write here, so every change is read-modify-written under a lock. */
export async function updateBoards<T>(
  stateDir: string, session: string, change: (boards: BoardRegistry) => T,
): Promise<T> {
  const path = boardsPath(stateDir, session)
  return withFileLock(path, async () => {
    const boards = (await readJson<BoardRegistry>(path)) ?? {}
    const outcome = change(boards)
    await writeJson(path, boards)
    return outcome
  })
}

export function sameStage(a: Staged | null | undefined, b: Staged | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.paneId === b.paneId && a.terminalId === b.terminalId
}

/**
 * False when no record names this board, or when `expected` is given and the
 * recorded stage is no longer it: the board writes a reconcile result back
 * only over the stage it read, so a stage the supervisor cleared meanwhile is
 * not resurrected.
 */
export async function recordStaged(
  stateDir: string, session: string, slug: string, staged: StagedWorker | null, expected?: StagedWorker | null,
): Promise<boolean> {
  return updateBoards(stateDir, session, (boards) => {
    const board = boards[slug]
    if (!board) return false
    if (expected !== undefined && !sameStage(board.staged, expected)) return false
    board.staged = staged
    return true
  })
}

// A move keeps the terminal id and renumbers the pane; a herdr restart keeps the pane id and changes the terminal id.
const stagedPane = (snap: Snapshot, staged: Staged) =>
  snap.panes.find((p) => p.terminal_id === staged.terminalId) ?? snap.panes.find((p) => p.pane_id === staged.paneId)

/**
 * The kit's `unstage` finds the worker by terminal id only, and when it misses
 * — as it does after a herdr restart — it closes the placeholder and gives up,
 * losing the worker's home spot. So the worker is found here and handed over
 * under the ids it has now. The pipeline workspace is never a worker's home,
 * so a worker found anywhere in it goes home from whichever tab it is in.
 */
export async function unstageBoard(herdr: Herdr, stateDir: string, session: string, slug: string): Promise<void> {
  const staged = (await readBoards(stateDir, session))[slug]?.staged
  if (!staged) return
  const snap = await readSnapshot(herdr)
  const pane = stagedPane(snap, staged)
  const current = pane ? { ...staged, terminalId: pane.terminal_id, paneId: pane.pane_id } : staged
  const host = pane?.workspace_id === staged.host.workspaceId ? { ...staged.host, tabId: pane.tab_id } : staged.host
  await unstage(herdr, snap, host, current)
  await recordStaged(stateDir, session, slug, null, staged)
}
