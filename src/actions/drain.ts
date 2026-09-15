import { join } from 'node:path'
import { drain } from '../lib/queue'
import { sessionKey } from '../lib/session'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
if (!stateDir) process.exit(0)

const events = await drain(join(stateDir, 'queue', sessionKey()))
if (events.length === 0) console.log('[pipeline] queue empty')
else console.log(JSON.stringify(events, null, 2))
