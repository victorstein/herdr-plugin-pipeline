import { repoContext } from '../lib/repo'
import { activeRunForRepo, retryOnStaleRun, saveRun, writeOrchestrator } from '../lib/ledger'
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

const run = await retryOnStaleRun(async () => {
  const active = await activeRunForRepo(stateDir, session, repoRoot)
  if (!active) return null
  active.orchestrator_pane = paneId
  active.history.push({ at: Date.now(), from: 'claim', to: active.phase, why: `orchestrator rebound to ${paneId}` })
  await saveRun(stateDir, active)
  return active
})
if (run) {
  console.log(`[pipeline] ${paneId} now drives ${run.run_id}`)
} else {
  console.log(`[pipeline] claimed ${paneId} for ${repoRoot}; no active run yet`)
}
