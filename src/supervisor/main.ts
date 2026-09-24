import { join } from 'node:path'
import { loadConfig } from '../lib/config'
import { Gh } from '../lib/gh'
import { Herdr } from '../lib/herdr'
import { clearPid, processStartedAtMs, supervisorState, writePid } from '../lib/pidfile'
import { drain } from '../lib/queue'
import {
  allOrchestratorPanes, isUnlandedSave, listRuns, loadRun, type RunEffect, saveOrReapply, saveRun,
} from '../lib/ledger'
import { rebindOrchestrator } from '../lib/orchestrator'
import { hpipeCommand, renderPrompt } from '../lib/render'
import { abandonParagraph, resumeCommand } from '../lib/status'
import { sessionKey } from '../lib/session'
import {
  absoluteArtifactPath, deliveriesFor, evaluateRun, type PendingPrompt, promptForRunPhase,
  refreshBadges, shouldRetry, uncommittedPaths,
} from './deliver'
import { isAgentReady } from '../lib/machine'
import {
  applyStalls, ladderFor, stallAwaiting, type StallDeps, stallCandidates,
  taskStallCandidates, undeliveredNote,
} from './stall'
import { applyEvents, describeWake, parkedFooter, pickOneAdvance, saveEventedRuns } from './tick'
import { ciTransitions } from './ci'
import { worktreeRemovalFrom } from './teardown'
import { advanceTasks, announceDecisions, type AnswerDeps, deliverPendingAnswers } from './tasks'
import { isFresh, isSettled, parseVerdict } from '../lib/predicates'
import type { AgentStatus, Run } from '../lib/types'

const EXIT_DUPLICATE = 3

/**
 * No in-place migration: a v4 run mid-`plan` has an orchestrator holding work no
 * worker can inherit. `hpipe status` tells the human to abort it.
 */
export function isCurrentSchemaRun(run: Run): boolean {
  return run.schema_version === 2
}

/**
 * One settle window per tick, not one per pane. Six workers at ACTOR_SETTLE_MS
 * serially would not fit inside TICK_MS. Reads are memoised per tick so a pane
 * consulted by several rows is polled once.
 */
export function makeSettledIdleReader(
  panes: string[], settleMs: number, status: (p: string) => Promise<AgentStatus>,
): (paneId: string) => Promise<boolean> {
  const results = new Map<string, Promise<boolean>>()
  for (const pane of panes) {
    results.set(pane, (async () => {
      if (!isAgentReady(await status(pane))) return false
      await Bun.sleep(settleMs)
      return isAgentReady(await status(pane))
    })())
  }
  return async (paneId: string) => (await results.get(paneId)) ?? false
}

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

  const attempts = new Map<string, number>()
  const ambiguityLog = new Set<string>()
  let lastCiPollMs = 0

  for (;;) {
    try {
      const events = await drain(queueDir)
      const allRuns = await listRuns(stateDir, session)
      const tickRuns = (config.REPOS_ALLOW.length === 0
        ? allRuns
        : allRuns.filter((r) => config.REPOS_ALLOW.includes(r.repo_key))
      ).filter(isCurrentSchemaRun)
      const panes = await allOrchestratorPanes(stateDir, session)

      const wakeOn = new Set(config.WAKE_ON)
      const applied = applyEvents(tickRuns, events, session, panes, wakeOn)

      // Saving before delivery keeps the ledger authoritative: a crash here loses
      // that tick's prompt, not the state transition, and the orchestrator can
      // recover with `hpipe status`. Events themselves are at-most-once —
      // drain() unlinks as it reads.
      const { runs, wake } = applied.changed
        ? await saveEventedRuns(tickRuns, applied.wake, {
          save: (run) => saveRun(stateDir, run),
          reload: (run) => loadRun(stateDir, session, run.run_id),
          reapply: (run) => applyEvents([run], events, session, panes, wakeOn),
          warn: (message) => console.error(message),
        })
        : { runs: tickRuns, wake: applied.wake }

      for (const line of wake) {
        // Gated on the event, not on task.agent_status: that field is the badge
        // and wake cache and is overwritten by every event in the same drain, so
        // a `blocked` then `idle` pair attached the tail to the wrong line.
        if (line.event === 'agent:blocked' && line.task?.pane_id) {
          const tail = await herdr.paneRead(line.task.pane_id, config.BLOCKED_TAIL_LINES)
          if (tail.trim().length > 0) {
            line.detail = tail.trim().split('\n').slice(-config.BLOCKED_TAIL_LINES).join('\n')
          }
        }
      }

      if (Date.now() - lastCiPollMs >= config.CI_POLL_SECONDS * 1000) {
        lastCiPollMs = Date.now()
        await ciTransitions(runs, (pr, repoRoot) => ghFor(repoRoot).prChecks(pr))
      }

      const advancing = pickOneAdvance(runs)
      const actorPanes = [...new Set(
        advancing
          .flatMap((r) => [r.orchestrator_pane, ...r.tasks.map((t) => t.pane_id)])
          .filter((p): p is string => p !== null),
      )]
      const liveIdle = makeSettledIdleReader(
        actorPanes, config.ACTOR_SETTLE_MS, (pane) => herdr.agentStatus(pane),
      )

      // One stamp and one CLI spelling per tick, so every line in one digest agrees
      // on "now". `hpipe` moves up from the stall block below; same call count.
      const tickNow = Date.now()
      const hpipe = hpipeCommand(pluginRoot)

      const pending: PendingPrompt[] = []
      const unsaved = new Set<Run>()
      for (const run of advancing) {
        const runPending: PendingPrompt[] = []
        const addPending = (
          paneId: string | null, text: string, eventLines: string[], subject: string,
          phaseNote?: string, footer?: string,
        ) => {
          if (text.length === 0 && eventLines.length === 0) return
          if (paneId === null) {
            console.error(`[pipeline] run ${run.run_id}: dropping prompt for ${subject} — no pane`)
            return
          }
          runPending.push({
            paneId, run, text, events: eventLines, phaseNote, footer,
            isOrchestrator: paneId === run.orchestrator_pane,
          })
        }
        const effects: RunEffect[] = []
        try {
          await rebindOrchestrator(stateDir, herdr, session, run)

          const runGh = ghFor(run.repo_root)
          const { nextPrompt, phaseNote } = await evaluateRun(run, runGh, config, liveIdle)

          const runPhaseBefore = run.phase
          const taskPrompts = await advanceTasks(run, {
            pluginRoot,
            liveIdle,
            maxPasses: config.MAX_PASSES,
            fileSettleMs: config.FILE_SETTLE_MS,
            prForBranch: (branch) => runGh.prForBranch(branch),
            prView: (pr) => runGh.prView(pr),
            issueView: (issue) => runGh.issueView(issue),
            verdictFor: async (r, t) => {
              const absolute = absoluteArtifactPath(r, t)
              if (!absolute) return null
              if (!(await isFresh(absolute, t.phase_entered_at))) return null
              if (!(await isSettled(absolute, config.FILE_SETTLE_MS))) return null
              return parseVerdict(absolute)
            },
            removeWorktree: async (ws) => worktreeRemovalFrom(await herdr.worktreeRemove(ws)),
            ciDetail: async (pr) => (pr === null ? '' : runGh.prChecksDetail(pr)),
            ambiguityLog,
            effects,
            uncommittedPaths,
          })

          // After advanceTasks, so a task resumed this tick gets a full tick to
          // settle before its phase is evaluated — the same grace every other
          // transition in the driver gets.
          const answerDeps: AnswerDeps = {
            pluginRoot,
            promptRetryMax: config.PROMPT_RETRY_MAX,
            send: (paneId, text) => herdr.agentPrompt(paneId, text),
            effects,
          }
          await deliverPendingAnswers(run, answerDeps)
          await announceDecisions(run, answerDeps)

          const enteredRunPhase = run.phase === runPhaseBefore
            ? ''
            : await promptForRunPhase(run, config)

          await refreshBadges(run, herdr, pluginId)
          const covered = new Set<string>()
          const lines = wake
            .filter((w) => w.run.run_id === run.run_id)
            .map((w) => {
              if (w.task) covered.add(w.task.task_id)
              return `- ${describeWake(w, tickNow, hpipe)}`
            })
          // Attached to every orchestrator-pane pending, not just the first: that
          // one is dropped when it has no text and no events, while a task prompt
          // on the same pane still produces a digest — which is the tick a task
          // advances off the CI poll rather than a pane event. `deliveriesFor`
          // renders it once.
          const footer = parkedFooter(run, covered, tickNow, hpipe)

          addPending(run.orchestrator_pane, nextPrompt, lines, `run phase${phaseNote}`,
            phaseNote, footer)
          for (const prompt of taskPrompts) {
            addPending(prompt.paneId, prompt.text, [], `task ${prompt.taskId}`, undefined,
              prompt.paneId === run.orchestrator_pane ? footer : undefined)
          }
          addPending(run.orchestrator_pane, enteredRunPhase, [], `run phase ${run.phase}`,
            undefined, footer)
          // Queued only once saved: a prompt about a transition the ledger then
          // refused would describe a state that no longer exists.
          if (await saveOrReapply(stateDir, run, effects) === 'saved') {
            pending.push(...runPending)
          } else {
            unsaved.add(run)
            console.error(`[pipeline] run ${run.run_id}: this tick lost to a CLI write; ` +
              `${effects.length} action(s) already taken were recorded on the fresh copy, ` +
              'the rest is re-evaluated next tick')
          }
        } catch (error) {
          if (isUnlandedSave(error)) {
            unsaved.add(run)
            console.error(`[pipeline] run ${run.run_id}: this tick not saved (${error.message}); ` +
              'its prompts are dropped and it is re-read next tick')
            continue
          }
          console.error(`[pipeline] run ${run.run_id} failed this tick:`, error)
        }
      }

      for (const delivery of deliveriesFor(pending)) {
        const sent = await herdr.agentPrompt(delivery.paneId, delivery.text)
        if (sent.ok) {
          attempts.delete(delivery.paneId)
          continue
        }
        const failures = (attempts.get(delivery.paneId) ?? 0) + 1
        if (shouldRetry(sent.code, failures, config.PROMPT_RETRY_MAX)) {
          attempts.set(delivery.paneId, failures)
        } else {
          console.error(`[pipeline] giving up on delivery to ${delivery.paneId}: ${sent.code}`)
          attempts.delete(delivery.paneId)
        }
      }

      // One binding, so the cap the candidates are built with, the cap the
      // ladder sentence quotes and the cap deferrals are bounded by cannot drift.
      const probeMax = config.STALL_PROBE_MAX
      const stallDeps: StallDeps = {
        probeMax,
        now: () => Date.now(),
        agentStatus: (paneId) => herdr.agentStatus(paneId),
        persist: (run, effect) => saveOrReapply(stateDir, run, effect ? [effect] : []),
        probe: async (c) => {
          const awaiting = stallAwaiting(c.run, c.task, hpipe)
          const text = await renderPrompt(pluginRoot, 'stall-probe', {
            run_id: c.run.run_id,
            phase: c.task
              ? `${c.task.phase} (${c.task.task_id}, ${c.task.branch})`
              : c.run.phase,
            minutes: String(c.minutes),
            awaiting: awaiting.clause,
            ladder: ladderFor(c, probeMax),
          })
          return herdr.agentPrompt(c.paneId, text)
        },
        escalationText: (c, from) => renderPrompt(pluginRoot, 'stall-escalate', {
          run_id: c.run.run_id,
          phase: from,
          minutes: String(c.minutes),
          probes: String(c.probes),
          undelivered: undeliveredNote(c.undelivered),
          awaiting_short: stallAwaiting(c.run, c.task, hpipe).short,
          // Rendered before the transition writes `escalated_from`, so `from` is passed.
          resume_command: resumeCommand(hpipe, c.run, c.task, from),
          abandon: abandonParagraph(hpipe, c.run, c.task),
        }),
        sendEscalation: async (c, text) => {
          const pane = c.run.orchestrator_pane
          if (pane === null) {
            console.error(
              `[pipeline] run ${c.run.run_id}: escalated but no orchestrator pane to tell`,
            )
            return
          }
          const sent = await herdr.agentPrompt(pane, text)
          if (!sent.ok) {
            console.error(
              `[pipeline] run ${c.run.run_id}: escalation prompt to ${pane} failed (${sent.code})` +
              ' — the transition is already recorded; `hpipe status` shows it',
            )
          }
        },
      }

      const savedRuns = runs.filter((run) => !unsaved.has(run))
      await applyStalls(
        stallCandidates(savedRuns, Date.now(), config.STALL_MINUTES, probeMax), stallDeps,
      )
      await applyStalls(
        taskStallCandidates(
          savedRuns, Date.now(), config.TASK_STALL_MINUTES, probeMax, config.STALL_MINUTES,
        ),
        stallDeps,
      )
    } catch (error) {
      console.error('[pipeline] tick error:', error)
    }
    await Bun.sleep(config.TICK_MS)
  }
}

if (import.meta.main) await main()
