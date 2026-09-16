import { join } from 'node:path'
import type { Gh } from '../lib/gh'
import type { Herdr } from '../lib/herdr'
import { advanceRun, counterFor, isAgentReady } from '../lib/machine'
import { runRow } from '../lib/phases'
import { isFresh, isSettled, parseVerdict, type VerdictResult } from '../lib/predicates'
import { renderPrompt } from '../lib/render'
import { buildBadges, badgeSource } from '../lib/badges'
import type { Config } from '../lib/config'
import type { Run, Task } from '../lib/types'
import { SETTLED } from './teardown'

export interface DigestInput {
  run: Run
  eventLines: string[]
  phaseNote: string
  nextPrompt: string
}

export interface Delivery { paneId: string; text: string; run: Run }

export function buildDigest(input: DigestInput): string {
  return [
    `[pipeline] run ${input.run.run_id}${input.phaseNote}`,
    '',
    `${input.eventLines.length} events:`,
    ...input.eventLines,
    '',
    input.nextPrompt,
  ].join('\n').trimEnd()
}

export interface PendingPrompt {
  paneId: string
  run: Run
  text: string
  isOrchestrator: boolean
  events: string[]
}

/**
 * Grouped by pane. The previous design returned ONE delivery per tick and
 * discarded the rest, which was safe only because every prompt-producing row had
 * the same recipient. With eight worker-owned rows a tick routinely produces
 * prompts for several panes, and a dropped one is never regenerated because the
 * run is already saved.
 */
export function deliveriesFor(pending: PendingPrompt[]): Delivery[] {
  const byPane = new Map<string, PendingPrompt[]>()
  for (const p of pending) {
    if (p.text.length === 0 && p.events.length === 0) continue
    const list = byPane.get(p.paneId) ?? []
    list.push(p)
    byPane.set(p.paneId, list)
  }

  const out: Delivery[] = []
  for (const [paneId, group] of byPane) {
    const first = group[0] as PendingPrompt
    const body = group.map((p) => p.text).filter((t) => t.length > 0).join('\n\n---\n\n')
    const events = group.flatMap((p) => p.events)
    const text = first.isOrchestrator
      ? buildDigest({
          run: first.run, eventLines: events,
          phaseNote: ` → ${first.run.phase}`, nextPrompt: body,
        })
      : body
    out.push({ paneId, text, run: first.run })
  }
  return out
}

const RETRYABLE = new Set(['agent_blocked', 'pane_not_found', 'not_found', 'unparseable'])

export function shouldRetry(code: string | undefined, attempts: number, max: number): boolean {
  if (attempts >= max) return false
  return code !== undefined && RETRYABLE.has(code)
}

/** Artifact path for the phase the run or task is currently in. */
export function artifactPathFor(run: Run, task: Task | null): string | null {
  if (task) {
    const key = `${task.task_id}-${task.phase}-${counterFor(task, task.phase)}`
    return run.artifacts.verdicts[key] ?? join('docs/superpowers/reviews', `${key}.md`)
  }
  const key = `${run.phase}-${counterFor(run, run.phase)}`
  return run.artifacts.verdicts[key] ?? join('docs/superpowers/reviews', `${run.run_id}-${key}.md`)
}

export function taskSignalsFor(run: Run) {
  const adopted = run.tasks
    .map((t) => t.adopted_at)
    .filter((at): at is number => at !== null)
  return {
    newestRegisteredAt: run.tasks.length > 0
      ? Math.max(...run.tasks.map((t) => t.registered_at))
      : null,
    newestAdoptedAt: adopted.length > 0 ? Math.max(...adopted) : null,
    tasksAllTerminal: run.tasks.length > 0 && run.tasks.every((t) => SETTLED.has(t.phase)),
    anyTaskDone: run.tasks.some((t) => t.phase === 'done'),
  }
}

/**
 * Evaluates one run. The actor must read idle both now and again after
 * ACTOR_SETTLE_MS — a momentary screen-detection misclassification will have
 * flipped back to working or blocked by then. This wait is its own explicit
 * sleep on config.ACTOR_SETTLE_MS rather than piggybacking on the artifact's
 * FILE_SETTLE_MS delay: the two settle windows guard unrelated subjects (file
 * write completion vs. screen-scrape flicker) and are independently tunable,
 * so conflating them would silently under- or over-wait whenever an operator
 * sets them to different values.
 */
export async function evaluateRun(
  run: Run, herdr: Herdr, gh: Gh, config: Config,
): Promise<{ advanced: boolean; nextPrompt: string; phaseNote: string }> {
  const stay = { advanced: false, nextPrompt: '', phaseNote: '' }
  const pane = run.orchestrator_pane
  if (!pane) return stay

  const signal = runRow(run.phase).signal
  const actorIdle = isAgentReady(await herdr.agentStatus(pane))

  let artifactFresh = false
  let verdict: VerdictResult | null = null

  if (signal === 'artifact' || signal === 'verdict') {
    if (!actorIdle) return stay

    const relative = artifactPathFor(run, null)
    if (!relative) return stay
    const absolute = join(run.repo_root, relative)

    if (!(await isFresh(absolute, run.phase_entered_at))) return stay
    if (!(await isSettled(absolute, config.FILE_SETTLE_MS))) return stay

    await Bun.sleep(config.ACTOR_SETTLE_MS)
    if (!isAgentReady(await herdr.agentStatus(pane))) return stay

    artifactFresh = true
    verdict = await parseVerdict(absolute)
  }

  const before = run.phase
  const advanced = advanceRun(run, {
    actorIdle, artifactFresh, verdict, maxPasses: config.MAX_PASSES,
    ...taskSignalsFor(run),
  })
  if (!advanced) return stay

  const nextPrompt = await promptForRunPhase(run, config)
  return { advanced: true, nextPrompt, phaseNote: ` → ${run.phase} (from ${before})` }
}

export async function promptForRunPhase(run: Run, _config: Config): Promise<string> {
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? process.cwd()
  const specPath = join(run.repo_root, run.artifacts.spec ?? 'docs/superpowers/specs/design.md')
  const planPath = join(run.repo_root, run.artifacts.plan ?? 'docs/superpowers/plans/plan.md')
  const verdictPath = join(run.repo_root, artifactPathFor(run, null) ?? 'review.md')

  const common = {
    run_id: run.run_id, title: run.title,
    pass: String(counterFor(run, run.phase)),
    spec_path: specPath, plan_path: planPath, verdict_path: verdictPath,
  }

  switch (run.phase) {
    case 'intake': return renderPrompt(pluginRoot, 'intake', common)
    case 'dispatch': return renderPrompt(pluginRoot, 'dispatch', common)
    case 'branch-review': return renderPrompt(pluginRoot, 'branch-review', common)
    case 'escalated': {
      const from = run.escalated_from ?? run.phase
      return renderPrompt(pluginRoot, 'escalate', {
        run_id: run.run_id, phase: from,
        pass: String(counterFor(run, from)), task_flag: '',
      })
    }
    default: return ''
  }
}

export async function refreshBadges(run: Run, herdr: Herdr, pluginId: string): Promise<void> {
  for (const task of run.tasks) {
    if (!task.workspace_id) continue
    await herdr.workspaceReportTokens(
      task.workspace_id,
      badgeSource(pluginId),
      buildBadges({ agent_status: task.agent_status, branch: task.branch, phase: task.phase }),
    )
  }
}
