import { beadsExportPath, beadsHome } from './lib/beads-project'
import { boardLabel, updateBoards } from './lib/boards'
import { bvSpawnEnv } from './lib/bv'
import { Herdr } from './lib/herdr'
import { sessionKey } from './lib/session'
import { BV_INSTALL_HINT, bvBin } from './lib/tools'

export interface BoardPaneDeps {
  env: Record<string, string | undefined>
  /** The pane's shell: it is exec'd into the user's shell when bv exits, keeping its pid. */
  parentPid: number
  now: () => number
  renamePane: (paneId: string, label: string) => Promise<unknown>
  updateBoards: typeof updateBoards
  which: (bin: string) => string | null
  runBv: (argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) => Promise<number>
  error: (message: string) => void
}

const processDeps = (): BoardPaneDeps => ({
  env: process.env,
  parentPid: process.ppid,
  now: Date.now,
  renamePane: (paneId, label) => new Herdr().paneRename(paneId, label),
  updateBoards,
  which: (bin) => Bun.which(bin),
  runBv: (argv, { cwd, env }) =>
    Bun.spawn(argv, { cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited,
  error: console.error,
})

/**
 * Records the board, then renames it — in that order, because the supervisor
 * closes a renamed board that no record names as a ghost. A board that cannot
 * record itself keeps its plain label and still runs bv: the human gets a board,
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
        boards[slug] = { pane_id: paneId, shell_pid: deps.parentPid, opened_at_ms: boards[slug]?.opened_at_ms ?? deps.now() }
      })
      await deps.renamePane(paneId, boardLabel(slug))
    } catch (error) {
      deps.error(`[pipeline] this board could not record itself for the supervisor: ${error}`)
    }
  }
  const bin = bvBin(deps.env)
  if (deps.which(bin) === null) {
    deps.error(`[pipeline] bv is not installed — ${BV_INSTALL_HINT}`)
    return 1
  }
  return deps.runBv([bin, '--db', beadsExportPath(stateDir, slug)], {
    cwd: beadsHome(stateDir, slug), env: bvSpawnEnv(stateDir, slug),
  })
}

if (import.meta.main) process.exit(await runBoardPane())
