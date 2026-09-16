import { join } from 'node:path'
import { loadConfig } from '../lib/config'
import { Gh } from '../lib/gh'
import { Herdr } from '../lib/herdr'
import { clearPid, processStartedAtMs, supervisorState, writePid } from '../lib/pidfile'
import { drain } from '../lib/queue'
import { allOrchestratorPanes, listRuns, saveRun } from '../lib/ledger'
import { rebindOrchestrator } from '../lib/orchestrator'
import { renderPrompt } from '../lib/render'
import { sessionKey } from '../lib/session'
import {
  artifactPathFor, type DigestInput, evaluateRun, nextDelivery, promptForRunPhase, refreshBadges, shouldRetry,
} from './deliver'
import { isAgentReady } from '../lib/machine'
import { stallCandidates, taskStallCandidates } from './stall'
import { applyEvents, pickOneAdvance } from './tick'
import { ciTransitions } from './ci'
import { advanceTasks } from './tasks'
import { isFresh, isSettled, parseVerdict } from '../lib/predicates'

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

  // gh must run inside the run's own checkout: a PR lookup resolves against the
  // repo of the working directory, and the supervisor's own cwd is the pipeline
  // workspace, which is not a repo at all.
  const ghClients = new Map<string, Gh>()
  const ghFor = (repoRoot: string): Gh => {
    let client = ghClients.get(repoRoot)
    if (!client) {
      client = new Gh(config.GH_BIN, repoRoot)
      ghClients.set(repoRoot, client)
    }
    return client
  }

  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? process.cwd()
  const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'
  const queueDir = join(stateDir, 'queue', session)

  console.log(`[pipeline] supervisor up — session ${session}, tick ${config.TICK_MS}ms`)

  const shutdown = () => { clearPid(stateDir, session); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  let attempts = 0
  let lastCiPollMs = 0
  const probed = new Set<string>()

  for (;;) {
    try {
      const events = await drain(queueDir)
      const allRuns = await listRuns(stateDir, session)
      const runs = config.REPOS_ALLOW.length === 0
        ? allRuns
        : allRuns.filter((r) => config.REPOS_ALLOW.includes(r.repo_key))
      const panes = await allOrchestratorPanes(stateDir, session)

      const { changed, wake } = applyEvents(runs, events, session, panes, new Set(config.WAKE_ON))

      for (const line of wake) {
        if (line.task?.agent_status === 'blocked' && line.task.pane_id) {
          const tail = await herdr.paneRead(line.task.pane_id, config.BLOCKED_TAIL_LINES)
          if (tail.trim().length > 0) {
            line.text += `\n    ${tail.trim().split('\n').slice(-config.BLOCKED_TAIL_LINES).join('\n    ')}`
          }
        }
      }

      // Saving before delivery keeps the ledger authoritative: a crash here loses
      // that tick's prompt, not the state transition, and the orchestrator can
      // recover with `hpipe status`. Events themselves are at-most-once —
      // drain() unlinks as it reads.
      if (changed) for (const run of runs) await saveRun(stateDir, run)

      if (Date.now() - lastCiPollMs >= config.CI_POLL_SECONDS * 1000) {
        lastCiPollMs = Date.now()
        await ciTransitions(runs, (pr, repoRoot) => ghFor(repoRoot).prChecks(pr))
      }

      const digests: DigestInput[] = []
      for (const run of pickOneAdvance(runs)) {
        try {
          await rebindOrchestrator(stateDir, herdr, session, run)

          const runGh = ghFor(run.repo_root)
          const { nextPrompt, phaseNote } = await evaluateRun(run, herdr, runGh, config)

          const actorIdle = run.orchestrator_pane !== null &&
            isAgentReady(await herdr.agentStatus(run.orchestrator_pane))

          const runPhaseBefore = run.phase
          const taskPrompts = await advanceTasks(run, {
            pluginRoot,
            actorIdle,
            maxPasses: config.MAX_PASSES,
            prForBranch: (branch) => runGh.prForBranch(branch),
            prView: (pr) => runGh.prView(pr),
            issueView: (issue) => runGh.issueView(issue),
            verdictFor: async (r, t) => {
              const relative = artifactPathFor(r, t)
              if (!relative) return null
              const absolute = join(r.repo_root, relative)
              if (!(await isFresh(absolute, t.phase_entered_at))) return null
              if (!(await isSettled(absolute, config.FILE_SETTLE_MS))) return null
              return parseVerdict(absolute)
            },
            removeWorktree: async (ws) => (await herdr.worktreeRemove(ws)).ok,
            ciDetail: async (pr) => (pr === null ? '' : runGh.prChecksDetail(pr)),
          })

          if (run.phase !== runPhaseBefore) {
            const entered = await promptForRunPhase(run, config)
            if (entered.length > 0) taskPrompts.push(entered)
          }

          await refreshBadges(run, herdr, pluginId)
          const lines = wake.filter((w) => w.run.run_id === run.run_id).map((w) => `- ${w.text}`)
          const combined = [nextPrompt, ...taskPrompts].filter((p) => p.length > 0).join('\n\n---\n\n')
          if (lines.length > 0 || combined.length > 0) {
            digests.push({ run, eventLines: lines, phaseNote, nextPrompt: combined })
          }
          await saveRun(stateDir, run)
        } catch (error) {
          console.error(`[pipeline] run ${run.run_id} failed this tick:`, error)
        }
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

      for (const candidate of stallCandidates(runs, Date.now(), config.STALL_MINUTES, probed)) {
        probed.add(candidate.key)
        const path = artifactPathFor(candidate.run, null)
        const text = await renderPrompt(
          pluginRoot, 'stall-probe', {
            run_id: candidate.run.run_id,
            phase: candidate.run.phase,
            minutes: String(candidate.minutes),
            artifact_path: join(candidate.run.repo_root, path ?? 'the expected artifact'),
          },
        )
        if (candidate.run.orchestrator_pane) {
          await herdr.agentPrompt(candidate.run.orchestrator_pane, text)
        }
      }

      for (const candidate of taskStallCandidates(runs, Date.now(), config.TASK_STALL_MINUTES, probed)) {
        probed.add(candidate.key)
        const text = await renderPrompt(pluginRoot, 'stall-probe', {
          run_id: candidate.run.run_id,
          phase: `implement (${candidate.task.task_id}, ${candidate.task.branch})`,
          minutes: String(candidate.minutes),
          artifact_path: `a PR for ${candidate.task.branch} (#${candidate.task.issue})`,
        })
        if (candidate.run.orchestrator_pane) {
          await herdr.agentPrompt(candidate.run.orchestrator_pane, text)
        }
      }
    } catch (error) {
      console.error('[pipeline] tick error:', error)
    }
    await Bun.sleep(config.TICK_MS)
  }
}

await main()
