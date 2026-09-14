import { join } from 'node:path'
import { loadConfig } from '../lib/config'
import { Gh } from '../lib/gh'
import { Herdr } from '../lib/herdr'
import { clearPid, processStartedAtMs, supervisorState, writePid } from '../lib/pidfile'
import { drain } from '../lib/queue'
import { allOrchestratorPanes, listRuns, saveRun } from '../lib/ledger'
import { sessionKey } from '../lib/session'
import { type DigestInput, evaluateRun, nextDelivery, refreshBadges, shouldRetry } from './deliver'
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
  const gh = new Gh(config.GH_BIN)
  const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'
  const queueDir = join(stateDir, 'queue')

  console.log(`[pipeline] supervisor up — session ${session}, tick ${config.TICK_MS}ms`)

  const shutdown = () => { clearPid(stateDir, session); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  let attempts = 0

  for (;;) {
    try {
      const events = await drain(queueDir)
      const runs = await listRuns(stateDir, session)
      const panes = await allOrchestratorPanes(stateDir, session)

      const { changed, wake } = applyEvents(runs, events, session, panes)

      // Ledger first, delivery second: a crash here replays harmlessly through dedup.
      if (changed) for (const run of runs) await saveRun(stateDir, run)

      const digests: DigestInput[] = []
      for (const run of pickOneAdvance(runs)) {
        const { nextPrompt, phaseNote } = await evaluateRun(run, herdr, gh, config)
        await refreshBadges(run, herdr, pluginId)
        const lines = wake.filter((w) => w.run.run_id === run.run_id).map((w) => `- ${w.text}`)
        if (lines.length > 0 || nextPrompt.length > 0) {
          digests.push({ run, eventLines: lines, phaseNote, nextPrompt })
        }
        await saveRun(stateDir, run)
      }

      const delivery = nextDelivery(digests)
      if (delivery) {
        const sent = await herdr.agentPrompt(delivery.paneId, delivery.text)
        if (!sent.ok) {
          attempts += 1
          if (!shouldRetry(sent.code, attempts, config.PROMPT_RETRY_MAX)) {
            console.error(`[pipeline] giving up on delivery: ${sent.code}`)
            attempts = 0
          }
        } else {
          attempts = 0
        }
      }
    } catch (error) {
      console.error('[pipeline] tick error:', error)
    }
    await Bun.sleep(config.TICK_MS)
  }
}

await main()
