import { Herdr } from '../lib/herdr'
import { listRuns } from '../lib/ledger'
import { supervisorState } from '../lib/pidfile'
import { sessionKey } from '../lib/session'
import { formatStatus } from '../lib/status'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
if (!stateDir) process.exit(0)

const session = sessionKey()
const state = await supervisorState(stateDir, session)
const livePanes = new Set((await new Herdr().paneList()).map((p) => p.pane_id))
console.log(formatStatus(
  await listRuns(stateDir, session),
  { state: state.state === 'live' ? 'live' : state.state, pid: 'info' in state ? state.info.pid : undefined },
  session,
  livePanes,
))
