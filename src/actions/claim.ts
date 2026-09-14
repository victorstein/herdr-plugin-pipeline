import { Herdr } from '../lib/herdr'
import { writeOrchestrator } from '../lib/ledger'
import { sessionKey } from '../lib/session'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
const paneId = process.env.HERDR_PANE_ID
const workspaceId = process.env.HERDR_WORKSPACE_ID
if (!stateDir || !paneId || !workspaceId) {
  console.error('[pipeline] claim must be invoked from inside a pane')
  process.exit(1)
}

const herdr = new Herdr()
const workspaces = await herdr.workspaceList()
const repoKey = workspaces.find((w) => w.workspace_id === workspaceId)?.worktree?.repo_key
if (!repoKey) {
  console.error('[pipeline] this workspace has no repo provenance — open it as a repo workspace first')
  process.exit(1)
}

await writeOrchestrator(stateDir, sessionKey(), repoKey, {
  pane_id: paneId,
  workspace_id: workspaceId,
  socket_path: process.env.HERDR_SOCKET_PATH ?? '',
  claimed_at: Date.now(),
})
console.log(`[pipeline] claimed ${paneId} as orchestrator for ${repoKey}`)
