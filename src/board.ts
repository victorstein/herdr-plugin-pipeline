import { boardLabel, updateBoards } from './lib/boards'
import { Herdr } from './lib/herdr'
import { sessionKey } from './lib/session'
import type { SessionKey } from './lib/types'

export interface BoardUiOptions {
  stateDir: string
  session: SessionKey
  slug: string
}

export interface BoardPaneDeps {
  env: Record<string, string | undefined>
  /** The pane's shell: it is exec'd into the user's shell when the board exits, keeping its pid. */
  parentPid: number
  now: () => number
  /** The pane and the tab it opened in. */
  renamePane: (paneId: string, label: string) => Promise<unknown>
  updateBoards: typeof updateBoards
  runUi: (options: BoardUiOptions) => Promise<number>
  error: (message: string) => void
}

const processDeps = (): BoardPaneDeps => ({
  env: process.env,
  parentPid: process.ppid,
  now: Date.now,
  renamePane: async (paneId, label) => {
    const herdr = new Herdr()
    await herdr.paneRename(paneId, label)
    await herdr.renameTabOf(paneId, label)
  },
  updateBoards,
  runUi: async (options) => (await import('./board/ui')).runBoardUi(options),
  error: console.error,
})

/**
 * Records the board, then renames it — in that order, because the supervisor
 * closes a renamed board that no record names as a ghost. A board that cannot
 * record itself keeps its plain label and still runs: the human gets a board,
 * and the supervisor's grace rule settles the record.
 */
export async function runBoardPane(deps: BoardPaneDeps = processDeps()): Promise<number> {
  const stateDir = deps.env.HERDR_PLUGIN_STATE_DIR
  const slug = deps.env.HPIPE_BEADS_SLUG
  const paneId = deps.env.HERDR_PANE_ID
  if (!stateDir || !slug) {
    deps.error('[pipeline] the board needs HERDR_PLUGIN_STATE_DIR and HPIPE_BEADS_SLUG')
    return 1
  }
  if (!paneId) {
    deps.error('[pipeline] no HERDR_PANE_ID, so this board cannot record itself for the supervisor')
  } else {
    try {
      await deps.updateBoards(stateDir, sessionKey(deps.env), (boards) => {
        boards[slug] = { ...boards[slug], pane_id: paneId, shell_pid: deps.parentPid, opened_at_ms: boards[slug]?.opened_at_ms ?? deps.now() }
      })
      await deps.renamePane(paneId, boardLabel(slug))
    } catch (error) {
      deps.error(`[pipeline] this board could not record itself for the supervisor: ${error}`)
    }
  }
  return deps.runUi({ stateDir, session: sessionKey(deps.env), slug })
}

if (import.meta.main) process.exit(await runBoardPane())
