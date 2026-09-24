import { repoContext } from '../lib/repo'
import {
  isUnlandedSave, resolveRun, retryOnStaleRun, saveRun, unlandedSaveMessage,
  writeOrchestrator,
} from '../lib/ledger'
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

let run
try {
  run = await retryOnStaleRun(async () => {
    const resolved = await resolveRun(stateDir, session, {
      runId: null, repoKey: repoRoot, phases: null, taskId: null, reach: 'unfinished',
    })
    if (!resolved.ok && resolved.reason === 'ambiguous') {
      // `hpipe start` refuses a second run per repo, so this is damage; rebinding
      // whichever sorts first would silently hand this pane the wrong one.
      console.error(`[pipeline] claimed ${paneId} for ${repoRoot}, but more than one run is ` +
        `active for it: ${resolved.candidates.map((r) => r.run_id).join(', ')} — ` +
        'none was rebound; abort the stray one and claim again')
      process.exit(1)
    }
    if (!resolved.ok) return null
    const active = resolved.run
    active.orchestrator_pane = paneId
    active.history.push({ at: Date.now(), from: 'claim', to: active.phase, why: `orchestrator rebound to ${paneId}` })
    await saveRun(stateDir, active)
    return active
  })
} catch (error) {
  if (!isUnlandedSave(error)) throw error
  console.error(`[pipeline] ${unlandedSaveMessage(error)}`)
  process.exit(1)
}
if (run) {
  console.log(`[pipeline] ${paneId} now drives ${run.run_id}`)
} else {
  console.log(`[pipeline] claimed ${paneId} for ${repoRoot}; no active run yet`)
}
