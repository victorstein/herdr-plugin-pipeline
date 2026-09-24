import { join } from 'node:path'
import { repoContext } from '../lib/repo'
import { writeOrchestrator } from '../lib/ledger'
import { claimRunForRepo } from '../lib/orchestrator'
import { hpipeCommand } from '../lib/render'
import { sessionKey } from '../lib/session'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
const paneId = process.env.HERDR_PANE_ID
const workspaceId = process.env.HERDR_WORKSPACE_ID
if (!stateDir || !paneId || !workspaceId) {
  console.error('[pipeline] claim must be invoked from inside a pane')
  process.exit(1)
}

// Identify the repo the same way `hpipe start` does, so the two agree.
const repo = await repoContext()
if (!repo) {
  console.error('[pipeline] claim must be invoked from inside a git repository')
  process.exit(1)
}
const repoRoot = repo.repoRoot

const session = sessionKey()
await writeOrchestrator(stateDir, session, repoRoot, {
  pane_id: paneId,
  workspace_id: workspaceId,
  socket_path: process.env.HERDR_SOCKET_PATH ?? '',
  claimed_at: Date.now(),
})

const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, '..', '..')
const outcome = await claimRunForRepo(stateDir, session, repoRoot, paneId, hpipeCommand(pluginRoot))
if (!outcome.ok) {
  console.error(`[pipeline] ${outcome.message}`)
  process.exit(1)
}
console.log(`[pipeline] ${outcome.message}`)
