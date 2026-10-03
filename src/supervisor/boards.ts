import { beadsHome, beadsSlug } from '../lib/beads-project'
import { BOARD_OPEN_GRACE_MS, type BoardRecord, readBoards, updateBoards } from '../lib/boards'
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
 * The placeholder is written before the pane is asked for, so the next tick
 * does not open a second board while this one boots. The pane id herdr reports
 * is filled in only if `board.ts` has not already recorded itself.
 */
export async function openBoard(slug: string, deps: Omit<BoardDeps, 'hasStore'>): Promise<void> {
  await updateBoards(deps.stateDir, deps.session, (boards) => {
    boards[slug] = { pane_id: null, shell_pid: null, opened_at_ms: deps.now() }
  })
  const opened = await deps.herdr.pluginPaneOpen(deps.pluginId, 'board', deps.workspaceId, {
    cwd: beadsHome(deps.stateDir, slug), env: { HPIPE_BEADS_SLUG: slug },
  })
  if (!opened.ok) {
    console.error(`[pipeline] could not open the board for ${slug}: ${opened.code} ${opened.message}`)
    await updateBoards(deps.stateDir, deps.session, (boards) => {
      if (boards[slug]?.pane_id === null) delete boards[slug]
    })
    return
  }
  const paneId = opened.result?.plugin_pane?.pane?.pane_id
  if (paneId === undefined) return
  await updateBoards(deps.stateDir, deps.session, (boards) => {
    const board = boards[slug]
    if (board !== undefined && board.pane_id === null) board.pane_id = paneId
  })
}

async function isLive(board: BoardRecord, listed: ReadonlySet<string>, deps: BoardDeps): Promise<boolean> {
  if (board.pane_id !== null && !listed.has(board.pane_id)) return false
  if (board.pane_id === null || board.shell_pid === null) {
    return deps.now() - board.opened_at_ms < BOARD_OPEN_GRACE_MS
  }
  const shellPid = await deps.herdr.paneShellPid(board.pane_id)
  // Unknown is not dead: closing a pane that cannot be identified could close a live board.
  return shellPid === undefined || shellPid === board.shell_pid
}

/** Exactly one live board per repo with a live run in this session, and none for any other. */
export async function syncBoards(runs: readonly Run[], deps: BoardDeps): Promise<void> {
  const wanted = new Set<string>()
  for (const slug of new Set(runs.filter((r) => r.phase !== 'done').map((r) => beadsSlug(r.repo_key)))) {
    if (await deps.hasStore(slug)) wanted.add(slug)
  }
  const recorded = await readBoards(deps.stateDir, deps.session)
  if (wanted.size === 0 && Object.keys(recorded).length === 0) return
  const listed = new Set((await deps.herdr.paneList(deps.workspaceId)).map((pane) => pane.pane_id))
  // The supervisor's own pane is always in this workspace, so an empty list is a failed
  // call; read as "every board is gone" it would open a duplicate of each.
  if (listed.size === 0) return

  for (const [slug, board] of Object.entries(recorded)) {
    if (wanted.has(slug)) continue
    if (board.pane_id !== null && listed.has(board.pane_id)) await deps.herdr.paneClose(board.pane_id)
    await updateBoards(deps.stateDir, deps.session, (boards) => { delete boards[slug] })
  }
  for (const slug of wanted) {
    const board = recorded[slug]
    if (board !== undefined && await isLive(board, listed, deps)) continue
    if (board?.pane_id != null && listed.has(board.pane_id)) await deps.herdr.paneClose(board.pane_id)
    await openBoard(slug, deps)
  }
}
