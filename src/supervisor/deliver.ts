import { join } from 'node:path'
import type { Gh } from '../lib/gh'
import type { Herdr } from '../lib/herdr'
import { ARTIFACT_RUN_PHASES, advanceRun, isAgentReady } from '../lib/machine'
import { isFresh, isSettled, parseVerdict } from '../lib/predicates'
import { renderPrompt } from '../lib/render'
import { buildBadges, badgeSource } from '../lib/badges'
import type { Config } from '../lib/config'
import type { Run, Task } from '../lib/types'

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

export function nextDelivery(inputs: DigestInput[]): Delivery | null {
  for (const input of inputs) {
    if (!input.run.orchestrator_pane) continue
    if (input.eventLines.length === 0 && input.nextPrompt.length === 0) continue
    return { paneId: input.run.orchestrator_pane, text: buildDigest(input), run: input.run }
  }
  return null
}

const RETRYABLE = new Set(['agent_blocked', 'pane_not_found', 'not_found', 'unparseable'])

export function shouldRetry(code: string | undefined, attempts: number, max: number): boolean {
  if (attempts >= max) return false
  return code !== undefined && RETRYABLE.has(code)
}

/** Artifact path for the phase the run or task is currently in. */
export function artifactPathFor(run: Run, task: Task | null): string | null {
  if (task) {
    const key = `${task.task_id}-${task.phase}-${task.pass}`
    return run.artifacts.verdicts[key] ?? join('docs/superpowers/reviews', `${key}.md`)
  }
  if (run.phase === 'spec') return run.artifacts.spec
  // `cmdStart` seeds `artifacts.spec` but never `artifacts.plan`, so without this fallback the
  // `plan` phase deadlocks: `evaluateRun` bails on a null path and never checks the file, while
  // `promptForRunPhase` has always told the orchestrator to write to this same default.
  if (run.phase === 'plan') return run.artifacts.plan ?? join('docs/superpowers/plans', 'plan.md')
  const key = `${run.phase}-${run.pass}`
  return run.artifacts.verdicts[key] ?? join('docs/superpowers/reviews', `${run.run_id}-${key}.md`)
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
  const pane = run.orchestrator_pane
  if (!pane) return { advanced: false, nextPrompt: '', phaseNote: '' }

  if (!ARTIFACT_RUN_PHASES.has(run.phase)) return { advanced: false, nextPrompt: '', phaseNote: '' }

  if (!isAgentReady(await herdr.agentStatus(pane))) {
    return { advanced: false, nextPrompt: '', phaseNote: '' }
  }

  const relative = artifactPathFor(run, null)
  if (!relative) return { advanced: false, nextPrompt: '', phaseNote: '' }
  const absolute = join(run.repo_root, relative)

  const fresh = await isFresh(absolute, run.phase_entered_at)
  if (!fresh) return { advanced: false, nextPrompt: '', phaseNote: '' }
  if (!(await isSettled(absolute, config.FILE_SETTLE_MS))) {
    return { advanced: false, nextPrompt: '', phaseNote: '' }
  }

  await Bun.sleep(config.ACTOR_SETTLE_MS)
  if (!isAgentReady(await herdr.agentStatus(pane))) {
    return { advanced: false, nextPrompt: '', phaseNote: '' }
  }

  const verdict = await parseVerdict(absolute)
  const before = run.phase
  const advanced = advanceRun(run, {
    actorIdle: true, artifactFresh: true, verdict, maxPasses: config.MAX_PASSES,
  })
  if (!advanced) return { advanced: false, nextPrompt: '', phaseNote: '' }

  const nextPrompt = await promptForRunPhase(run, config)
  return { advanced: true, nextPrompt, phaseNote: ` → ${run.phase} (from ${before})` }
}

export async function promptForRunPhase(run: Run, _config: Config): Promise<string> {
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? process.cwd()
  const specPath = join(run.repo_root, run.artifacts.spec ?? 'docs/superpowers/specs/design.md')
  const planPath = join(run.repo_root, run.artifacts.plan ?? 'docs/superpowers/plans/plan.md')
  const verdictPath = join(run.repo_root, artifactPathFor(run, null) ?? 'review.md')

  const common = {
    run_id: run.run_id, title: run.title, pass: String(run.pass),
    spec_path: specPath, plan_path: planPath, verdict_path: verdictPath,
  }

  switch (run.phase) {
    case 'spec': return renderPrompt(pluginRoot, 'spec', common)
    case 'spec-review': return renderPrompt(pluginRoot, 'spec-review', common)
    case 'plan': return renderPrompt(pluginRoot, 'plan', common)
    case 'plan-review': return renderPrompt(pluginRoot, 'plan-review', common)
    case 'dispatch': return renderPrompt(pluginRoot, 'dispatch', common)
    case 'branch-review': return renderPrompt(pluginRoot, 'branch-review', common)
    case 'escalated':
      return renderPrompt(pluginRoot, 'escalate', {
        run_id: run.run_id, phase: run.escalated_from ?? run.phase,
        pass: String(run.pass), task_flag: '',
      })
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
