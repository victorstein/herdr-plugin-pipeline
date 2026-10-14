import { join } from 'node:path'
import { observePanes } from '../lib/delivery-health'
import { readDispatchLocks } from '../lib/dispatch-lock'
import { Herdr } from '../lib/herdr'
import { listRuns } from '../lib/ledger'
import { supervisorState } from '../lib/pidfile'
import { hpipeCommand } from '../lib/render'
import { sessionKey } from '../lib/session'
import { formatStatus } from '../lib/status'
import { checkTools, toolsLine } from '../lib/tools'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
if (!stateDir) process.exit(0)

const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, '..', '..')
const session = sessionKey()
const state = await supervisorState(stateDir, session)
const herdr = new Herdr()
const { livePanes, panes } = await observePanes(
  () => herdr.paneList(), stateDir, session, state.state === 'live' ? state.info.pid : undefined,
)
const runs = await listRuns(stateDir, session)
console.log(formatStatus(
  runs,
  { state: state.state === 'live' ? 'live' : state.state, pid: 'info' in state ? state.info.pid : undefined },
  session,
  hpipeCommand(pluginRoot),
  livePanes,
  Date.now(),
  panes,
  toolsLine(await checkTools()),
  await readDispatchLocks(stateDir, runs.map((run) => run.repo_key)),
))
