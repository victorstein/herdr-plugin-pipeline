import { beadsSlug, readBeadsProject } from '../lib/beads-project'
import { readBoards, updateBoards } from '../lib/boards'
import { loadConfig } from '../lib/config'
import { Herdr } from '../lib/herdr'
import { repoContext } from '../lib/repo'
import { sessionKey } from '../lib/session'
import { ensureWorkspace } from '../startup'
import { openBoard } from '../supervisor/boards'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'
if (!stateDir || !configDir) process.exit(0)

const repo = await repoContext()
if (!repo) {
  console.error('[pipeline] "Open board" must be invoked from a pane inside a git repository')
  process.exit(1)
}
const slug = beadsSlug(repo.repoKey)
if ((await readBeadsProject(stateDir, slug)) === null) {
  console.error('[pipeline] this repo has no Beads store yet — run "Set up Beads for this repo" first')
  process.exit(1)
}

const session = sessionKey()
const config = await loadConfig(configDir)
const herdr = new Herdr()
const workspaceId = await ensureWorkspace(herdr, stateDir, session, config.PIPELINE_WORKSPACE_LABEL)
if (!workspaceId) {
  console.error('[pipeline] could not resolve the pipeline workspace')
  process.exit(1)
}

const recorded = (await readBoards(stateDir, session))[slug]
if (recorded?.pane_id) await herdr.paneClose(recorded.pane_id)
await updateBoards(stateDir, session, (boards) => { delete boards[slug] })
await openBoard(slug, { stateDir, session, pluginId, workspaceId, now: Date.now, herdr })
console.log(`[pipeline] board opened for ${slug}`)
