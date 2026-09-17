import { join } from 'node:path'
import type { Gh } from '../lib/gh'
import type { Herdr } from '../lib/herdr'
import { advanceRun, counterFor } from '../lib/machine'
import { runRow, taskRow } from '../lib/phases'
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
  /** `evaluateRun`'s " → to (from X)"; the transition is why the digest arrived. */
  phaseNote?: string
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
          phaseNote: group.find((p) => p.phaseNote)?.phaseNote ?? ` → ${first.run.phase}`,
          nextPrompt: body,
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
// Verdicts land here as well as artifacts, and nothing ever populates
// `artifacts.verdicts` — `artifactPathFor` reads it and no writer exists — so the
// `claimed` set cannot exclude them and `adoptableArtifacts` filters by prefix
// instead. Every completed branch carries three to five.
const REVIEWS_DIR = 'docs/superpowers/reviews'

export function artifactPathFor(run: Run, task: Task | null): string | null {
  if (task) {
    const row = taskRow(task.phase)
    if (row.artifact) return task.artifacts[row.artifact]
    const key = `${task.phase}-${counterFor(task, task.phase)}`
    return task.artifacts.verdicts[key]
      ?? join(REVIEWS_DIR, `issue-${task.issue}-${key}.md`)
  }
  const key = `${run.phase}-${counterFor(run, run.phase)}`
  return run.artifacts.verdicts[key] ?? join(REVIEWS_DIR, `${run.run_id}-${key}.md`)
}

/** Task artifacts live in the worker's linked worktree; run artifacts in the main checkout. */
export function absoluteArtifactPath(run: Run, task: Task | null): string | null {
  const rel = artifactPathFor(run, task)
  if (rel === null) return null
  const base = task?.checkout_path ?? run.repo_root
  return join(base, rel)
}

/** The branch every worker worktree is cut from; `prompts/dispatch.md` mandates `--base main`. */
const ARTIFACT_BASE_REF = 'main'

// Bun.spawn throws synchronously on a missing binary, and this runs inside the
// supervisor tick, so that must degrade to a non-ok result rather than crash the
// loop — the same contract Gh.run holds. A bad `-C` path does not throw; git exits
// non-zero and the caller's code check catches it.
//
// `diff.renames=true` is pinned rather than inherited: a user gitconfig disabling
// rename detection turns a `git mv`d doc into a false `A` and therefore a false
// candidate, which is the one way this scan can adopt the wrong file.
async function git(checkoutPath: string, args: string[]): Promise<{ code: number; text: string }> {
  try {
    const proc = Bun.spawn(['git', '-c', 'diff.renames=true', '-C', checkoutPath, ...args], {
      stdout: 'pipe', stderr: 'ignore',
    })
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    return { code, text }
  } catch {
    return { code: -1, text: '' }
  }
}

/**
 * Docs this branch ADDED. The worker was given one path and wrote another — 3 of 6
 * research notes on the berean-os run of 2026-09-16 — so ask the branch what it
 * added rather than the filesystem what is recent: `git worktree add` stamps every
 * checked-out file with the current mtime, and `research`'s phase_entered_at
 * predates the worktree, so no mtime comparison separates the worker's note from
 * the whole repo's docs.
 *
 * `-z` emits raw NUL-terminated paths, so a non-ASCII filename is not C-quoted.
 */
export async function adoptableArtifacts(
  checkoutPath: string | null, claimed: Set<string>,
): Promise<string[]> {
  // Adoption is a worktree-scoped repair. With no checkout the scan would run
  // against the main checkout, shared with the orchestrator, the run-level
  // branch-review artifact and every sibling's merged docs.
  if (checkoutPath === null) return []

  const base = await git(checkoutPath, ['rev-parse', '--verify', '--quiet', ARTIFACT_BASE_REF])
  if (base.code !== 0) return []

  const diff = await git(checkoutPath, [
    'diff', '-z', '--name-only', '--diff-filter=A', `${ARTIFACT_BASE_REF}...HEAD`, '--', 'docs/',
  ])
  if (diff.code !== 0) return []

  return diff.text
    .split('\0')
    .filter((path) => path.length > 0)
    .filter((path) => !path.startsWith(`${REVIEWS_DIR}/`))
    .filter((path) => !claimed.has(path))
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
 * Evaluates one run. `liveIdle` is the tick's shared reader: the orchestrator
 * pane must read idle both now and again after ACTOR_SETTLE_MS, because a
 * momentary screen-detection misclassification will have flipped back to
 * working or blocked by then. That double-check rides its own explicit sleep on
 * config.ACTOR_SETTLE_MS rather than piggybacking on the artifact's
 * FILE_SETTLE_MS delay: the two settle windows guard unrelated subjects (file
 * write completion vs. screen-scrape flicker) and are independently tunable,
 * so conflating them would silently under- or over-wait whenever an operator
 * sets them to different values.
 */
export async function evaluateRun(
  run: Run, gh: Gh, config: Config, liveIdle: (paneId: string) => Promise<boolean>,
): Promise<{ advanced: boolean; nextPrompt: string; phaseNote: string }> {
  const stay = { advanced: false, nextPrompt: '', phaseNote: '' }
  const pane = run.orchestrator_pane
  if (!pane) return stay

  const signal = runRow(run.phase).signal
  const actorIdle = await liveIdle(pane)

  let artifactFresh = false
  let verdict: VerdictResult | null = null

  if (signal === 'artifact' || signal === 'verdict') {
    if (!actorIdle) return stay

    const absolute = absoluteArtifactPath(run, null)
    if (!absolute) return stay

    if (!(await isFresh(absolute, run.phase_entered_at))) return stay
    if (!(await isSettled(absolute, config.FILE_SETTLE_MS))) return stay

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
  const verdictPath = absoluteArtifactPath(run, null) ?? join(run.repo_root, 'review.md')

  const common = {
    run_id: run.run_id, title: run.title,
    pass: String(counterFor(run, run.phase)),
    verdict_path: verdictPath,
    repo_root: run.repo_root,
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
