import { beadsHome, beadsSlug } from '../lib/beads-project'
import {
  BOARD_OPEN_GRACE_MS, type BoardRecord, isRenamedBoardLabel, readBoards, recordedBoardPanes, sameBoard,
  updateBoards,
} from '../lib/boards'
import type { Herdr } from '../lib/herdr'
import type { Run } from '../lib/types'

export interface BoardDeps {
  stateDir: string
  session: string
  pluginId: string
  workspaceId: string
  now: () => number
  hasStore: (slug: string) => Promise<boolean>
  herdr: Pick<Herdr, 'paneList' | 'paneShellPid' | 'paneClose' | 'pluginPaneOpen'>
}

/**
 * Opens a board only if the slug's record is still `expected`, the one the caller
 * decided on: the supervisor's tick and the "Open board" action can both reach
 * here for one slug, and the loser must not open a second board. The placeholder
 * is written before the pane is asked for, so the next tick does not open another
 * while this one boots. The pane id herdr reports is recorded at once, because an
 * unrecorded renamed board reads as a ghost.
 */
export async function openBoard(
  slug: string, deps: Omit<BoardDeps, 'hasStore'>, expected: BoardRecord | undefined,
): Promise<boolean> {
  const placeholder: BoardRecord = { pane_id: null, shell_pid: null, opened_at_ms: deps.now() }
  const claimed = await updateBoards(deps.stateDir, deps.session, (boards) => {
    if (!sameBoard(boards[slug], expected)) return false
    boards[slug] = placeholder
    return true
  })
  if (!claimed) return false

  const opened = await deps.herdr.pluginPaneOpen(deps.pluginId, 'board', deps.workspaceId, {
    cwd: beadsHome(deps.stateDir, slug), env: { HPIPE_BEADS_SLUG: slug },
  })
  if (!opened.ok) {
    console.error(`[pipeline] could not open the board for ${slug}: ${opened.code} ${opened.message}`)
    await updateBoards(deps.stateDir, deps.session, (boards) => {
      if (sameBoard(boards[slug], placeholder)) delete boards[slug]
    })
    return false
  }
  const paneId = opened.result?.plugin_pane?.pane?.pane_id
  if (paneId !== undefined) {
    await updateBoards(deps.stateDir, deps.session, (boards) => {
      const board = boards[slug]
      if (board !== undefined && board.pane_id === null) board.pane_id = paneId
    })
  }
  return true
}

async function isLive(board: BoardRecord, listed: ReadonlySet<string>, deps: BoardDeps): Promise<boolean> {
  const booting = deps.now() - board.opened_at_ms < BOARD_OPEN_GRACE_MS
  // The action can open and record a board between this tick's pane list and its
  // registry read, so a fresh record of an unlisted pane is one still booting.
  if (board.pane_id !== null && !listed.has(board.pane_id)) return booting
  if (board.pane_id === null || board.shell_pid === null) return booting
  const shellPid = await deps.herdr.paneShellPid(board.pane_id)
  // Unknown is not dead: closing a pane that cannot be identified could close a live board.
  return shellPid === undefined || shellPid === board.shell_pid
}

/**
 * Exactly one live board per repo with a live run in this session, and none for
 * any other. A pane renamed `Board: …` that no record names is a ghost — herdr
 * restores panes under new ids after a restart — and is closed.
 */
export async function syncBoards(runs: readonly Run[], deps: BoardDeps): Promise<void> {
  const wanted = new Set<string>()
  for (const slug of new Set(runs.filter((r) => r.phase !== 'done').map((r) => beadsSlug(r.repo_key)))) {
    if (await deps.hasStore(slug)) wanted.add(slug)
  }
  // Listed before the registry is read: `board.ts` records itself before it renames,
  // so every renamed pane in this list is already in the registry read after it.
  const panes = await deps.herdr.paneList(deps.workspaceId)
  // The supervisor's own pane is always in this workspace, so an empty list is a failed
  // call; read as "every board is gone" it would open a duplicate of each.
  if (panes.length === 0) return
  const recorded = await readBoards(deps.stateDir, deps.session)
  const listed = new Set(panes.map((pane) => pane.pane_id))

  const recordedPanes = recordedBoardPanes(recorded)
  for (const pane of panes) {
    if (isRenamedBoardLabel(pane.label) && !recordedPanes.has(pane.pane_id)) await deps.herdr.paneClose(pane.pane_id)
  }

  for (const [slug, board] of Object.entries(recorded)) {
    if (wanted.has(slug)) continue
    if (board.pane_id !== null && listed.has(board.pane_id) && !(await deps.herdr.paneClose(board.pane_id)).ok) continue
    await updateBoards(deps.stateDir, deps.session, (boards) => {
      if (sameBoard(boards[slug], board)) delete boards[slug]
    })
  }
  for (const slug of wanted) {
    const board = recorded[slug]
    if (board !== undefined && await isLive(board, listed, deps)) continue
    if (board?.pane_id != null && listed.has(board.pane_id) && !(await deps.herdr.paneClose(board.pane_id)).ok) continue
    await openBoard(slug, deps, board)
  }
}
