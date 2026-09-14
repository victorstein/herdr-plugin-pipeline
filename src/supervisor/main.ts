import { join } from 'node:path'
import { loadConfig } from '../lib/config'
import { Herdr } from '../lib/herdr'
import { clearPid, processStartedAtMs, supervisorState, writePid } from '../lib/pidfile'
import { drain } from '../lib/queue'
import { allOrchestratorPanes, listRuns, saveRun } from '../lib/ledger'
import { sessionKey } from '../lib/session'
import { applyEvents, pickOneAdvance } from './tick'

const EXIT_DUPLICATE = 3

async function main(): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
  if (!stateDir || !configDir) {
    console.error('[pipeline] missing HERDR_PLUGIN_STATE_DIR or HERDR_PLUGIN_CONFIG_DIR')
    process.exit(1)
  }

  const session = sessionKey()
  const existing = await supervisorState(stateDir, session)
  if (existing.state === 'live') {
    console.log(`[pipeline] another supervisor is live (pid ${existing.info.pid}, session ${session})`)
    process.exit(EXIT_DUPLICATE)
  }
  if (existing.state === 'stale') {
    console.log(`[pipeline] reclaiming stale pid file (pid ${existing.info.pid})`)
    clearPid(stateDir, session)
  }

  await writePid(stateDir, {
    pid: process.pid,
    pane_pid: process.ppid,
    started_at_ms: (await processStartedAtMs(process.pid)) ?? Date.now(),
    session,
    socket_path: process.env.HERDR_SOCKET_PATH ?? '',
    pane_id: process.env.HERDR_PANE_ID ?? '',
  })

  const config = await loadConfig(configDir)
  const herdr = new Herdr()
  const queueDir = join(stateDir, 'queue')

  console.log(`[pipeline] supervisor up — session ${session}, tick ${config.TICK_MS}ms`)

  const shutdown = () => { clearPid(stateDir, session); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  for (;;) {
    try {
      const events = await drain(queueDir)
      const runs = await listRuns(stateDir, session)
      const panes = await allOrchestratorPanes(stateDir, session)

      const { changed } = applyEvents(runs, events, session, panes)

      // Ledger first, delivery second: a crash here replays harmlessly through dedup.
      if (changed) for (const run of runs) await saveRun(stateDir, run)

      for (const run of pickOneAdvance(runs)) {
        void run // Task 26 wires evaluation, badges, and delivery onto this loop.
      }
    } catch (error) {
      console.error('[pipeline] tick error:', error)
    }
    await Bun.sleep(config.TICK_MS)
  }
}

await main()
