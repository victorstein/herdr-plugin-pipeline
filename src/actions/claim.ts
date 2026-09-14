import { activeRunForRepo, saveRun, writeOrchestrator } from '../lib/ledger'
import { sessionKey } from '../lib/session'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
const paneId = process.env.HERDR_PANE_ID
const workspaceId = process.env.HERDR_WORKSPACE_ID
if (!stateDir || !paneId || !workspaceId) {
  console.error('[pipeline] claim must be invoked from inside a pane')
  process.exit(1)
}

// Identify the repo the same way `hpipe start` does — the git toplevel — rather
// than by herdr's opaque repo_key, so the two agree.
const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore' })
const repoRoot = (await new Response(proc.stdout).text()).trim()
await proc.exited
if (repoRoot.length === 0) {
  console.error('[pipeline] claim must be invoked from inside a git repository')
  process.exit(1)
}

const session = sessionKey()
await writeOrchestrator(stateDir, session, repoRoot, {
  pane_id: paneId,
  workspace_id: workspaceId,
  socket_path: process.env.HERDR_SOCKET_PATH ?? '',
  claimed_at: Date.now(),
})

const run = await activeRunForRepo(stateDir, session, repoRoot)
if (run) {
  run.orchestrator_pane = paneId
  run.history.push({ at: Date.now(), from: 'claim', to: run.phase, why: `orchestrator rebound to ${paneId}` })
  await saveRun(stateDir, run)
  console.log(`[pipeline] ${paneId} now drives ${run.run_id}`)
} else {
  console.log(`[pipeline] claimed ${paneId} for ${repoRoot}; no active run yet`)
}
