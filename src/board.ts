import { beadsExportPath, beadsHome } from './lib/beads-project'
import { boardLabel, updateBoards } from './lib/boards'
import { bvSpawnEnv } from './lib/bv'
import { Herdr } from './lib/herdr'
import { sessionKey } from './lib/session'
import { BV_INSTALL_HINT, bvBin } from './lib/tools'

async function main(): Promise<number> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  const slug = process.env.HPIPE_BEADS_SLUG
  const paneId = process.env.HERDR_PANE_ID
  if (!stateDir || !slug) {
    console.error('[pipeline] the board needs HERDR_PLUGIN_STATE_DIR and HPIPE_BEADS_SLUG')
    return 1
  }
  if (paneId) {
    await new Herdr().paneRename(paneId, boardLabel(slug))
    // The pane's shell is this process's parent and is exec'd into the user's shell
    // when bv exits, keeping its pid; a herdr restart brings the pane back as a fresh
    // shell under another pid, which is how the supervisor spots a ghost.
    await updateBoards(stateDir, sessionKey(), (boards) => {
      boards[slug] = { pane_id: paneId, shell_pid: process.ppid, opened_at_ms: boards[slug]?.opened_at_ms ?? Date.now() }
    })
  }
  if (Bun.which(bvBin()) === null) {
    console.error(`[pipeline] bv is not installed — ${BV_INSTALL_HINT}`)
    return 1
  }
  const bv = Bun.spawn([bvBin(), '--db', beadsExportPath(stateDir, slug)], {
    cwd: beadsHome(stateDir, slug), env: bvSpawnEnv(stateDir, slug),
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  return bv.exited
}

if (import.meta.main) process.exit(await main())
