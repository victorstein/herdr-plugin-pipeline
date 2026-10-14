import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  batchPrBody, batchPrBodyPath, checkoutSteps, rulesetPattern, sha8, squashBody, squashBodyPath, squashSubject,
  suggestedPrTitle,
} from '../lib/batch'
import {
  batchHoldVars, checkName, checksIn, checkState, isOwed, owedAt, rulingsNote, stateClause,
} from '../lib/before-merge'
import { CHECK_REL, repoCheck } from '../lib/check'
import type { Gh } from '../lib/gh'
import type { Herdr } from '../lib/herdr'
import { ciCheckFirst, runChangeVars } from '../lib/change-prompt'
import { mainlineBranch, remoteBranchHeadCooled, trackingRefspec } from '../lib/dispatch-base'
import { dispatchRunningLine, type DispatchLocks, NO_DISPATCHES, runDispatchUnderWay } from '../lib/dispatch-lock'
import { hasLanded } from '../lib/ledger'
import { excludeFromGit } from '../lib/repo'
import { advanceRun, type BatchPr, counterFor } from '../lib/machine'
import { IMPLEMENT_MODEL } from '../lib/models'
import { modeOf, runRow, taskRow } from '../lib/phases'
import { isFresh, isSettled, parseVerdict, type VerdictResult } from '../lib/predicates'
import { hpipeCommand, renderPrompt } from '../lib/render'
import { resumeCommand } from '../lib/status'
import { branchReviewEffort, taskTiers } from '../lib/tier-prompt'
import {
  artifactBase, REVIEWS_DIR, type ReserveWarn, reserveVerdict, verdictFilename, verdictFor,
  verdictPrefix,
} from '../lib/verdict-path'
import { buildBadges, badgeSource } from '../lib/badges'
import type { Config } from '../lib/config'
import type { Batch, Run, Task, TaskPhase } from '../lib/types'
import { shellQuoted, shellWord } from '../lib/unstarted'
import { holdKey, notePastSubagents, type SubagentHold } from './pane-background'
import { FINISHED } from './teardown'
import { isAncestor, resolveCommit } from '../lib/sync-walk'

export interface DigestInput {
  run: Run
  eventLines: string[]
  phaseNote: string
  nextPrompt: string
  /** Optional so the existing `buildDigest` literals keep compiling. */
  footer?: string
}

export interface Delivery {
  paneId: string
  text: string
  run: Run
  /** The outbox entries this delivery carries, so its outcome can be written back to each. */
  sources: Array<{ run: Run; outboxId: string }>
  /** Carries event lines or text kept nowhere else, so an undelivered one is lost. */
  ephemeral?: boolean
}

export function buildDigest(input: DigestInput): string {
  // Each non-empty tail part brings exactly one blank line with it, so the output
  // is byte-identical to the old fixed-slot join whenever there is no footer.
  const tail = [input.nextPrompt, input.footer ?? ''].filter((part) => part.length > 0)
  // A prompt with no events under it read as "0 events:" and nothing more.
  const events = input.eventLines.length === 0 ? [] : ['', `${input.eventLines.length} events:`, ...input.eventLines]
  return [
    `[pipeline] run ${input.run.run_id}${input.phaseNote}`,
    ...events,
    ...tail.flatMap((part) => ['', part]),
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
  /** The parked-task footer; set on every orchestrator pending, rendered once. */
  footer?: string
  /** The task this prompt is about; absent for a run-level one. */
  taskId?: string
  /** Set on a prompt read back out of the outbox. */
  outboxId?: string
}

/**
 * Grouped by pane and run. The previous design returned ONE delivery per tick and
 * discarded the rest, which was safe only because every prompt-producing row had
 * the same recipient. With eight worker-owned rows a tick routinely produces
 * prompts for several panes, and a dropped one is never regenerated because the
 * run is already saved. The run is in the key because an `escalated` run releases
 * its pane to the next run started there, and one digest header names one run.
 */
export function deliveriesFor(pending: PendingPrompt[]): Delivery[] {
  const byRecipient = new Map<string, PendingPrompt[]>()
  for (const p of pending) {
    if (p.text.length === 0 && p.events.length === 0) continue
    const key = `${p.paneId}\0${p.run.run_id}`
    const list = byRecipient.get(key) ?? []
    list.push(p)
    byRecipient.set(key, list)
  }

  const out: Delivery[] = []
  for (const group of byRecipient.values()) {
    // Each outbox entry is its own send, so a text-level rejection drops only the
    // entry that caused it and a failure is settled against only what it carried.
    // The tick's event lines, footer and any unqueued text ride with the first.
    const queued = group.filter((p) => p.outboxId !== undefined)
    const unqueued = group.filter((p) => p.outboxId === undefined)
    const units = queued.length === 0
      ? [unqueued]
      : queued.map((entry, i) => (i === 0 ? [...unqueued, entry] : [entry]))
    units.forEach((unit, i) => out.push(deliveryOf(unit, group, i === 0)))
  }
  return out
}

function deliveryOf(unit: PendingPrompt[], group: PendingPrompt[], leads: boolean): Delivery {
  const first = group[0] as PendingPrompt
  const body = unit.map((p) => p.text).filter((t) => t.length > 0).join('\n\n---\n\n')
  const text = first.isOrchestrator
    ? buildDigest({
        run: first.run, eventLines: unit.flatMap((p) => p.events),
        phaseNote: unit.find((p) => p.phaseNote)?.phaseNote ?? ` → ${first.run.phase}`,
        footer: leads ? (group.find((p) => p.footer)?.footer ?? '') : '',
        nextPrompt: body,
      })
    : body
  const sources = unit.flatMap((p) =>
    (p.outboxId === undefined ? [] : [{ run: p.run, outboxId: p.outboxId }]))
  const ephemeral = unit.some((p) =>
    p.events.length > 0 || (p.outboxId === undefined && p.text.length > 0))
  return { paneId: first.paneId, text, run: first.run, sources, ephemeral }
}

/** The tick's prefix for a lib-level anomaly; `src/lib/` emits none of its own. */
export const warnToTick: ReserveWarn = (message) => console.error(`[pipeline] ${message}`)

// The only codes that say herdr will never accept this TEXT, however often it is
// sent — so the prompt is dropped rather than left to block its pane. A deny-list,
// not an allow-list: dropping is the outbox's one irreversible step, and herdr
// 0.9.0 has recipient-side codes (`agent_not_running`, `agent_pane_busy`,
// `agent_pane_unavailable`, `agent_launch_pending`, `agent_not_idle`, …) that no
// allow-list here had heard of. An unknown code holds and backs the pane off.
const ABOUT_THE_TEXT: ReadonlySet<string> = new Set([
  'empty_agent_prompt', 'invalid_agent_argument', 'invalid_params', 'invalid_request',
])

export function isRetryable(code: string): boolean {
  return !ABOUT_THE_TEXT.has(code)
}

/**
 * Artifact path for the phase the run or task is currently in.
 *
 * Verdict paths are recorded, not derived: `reserveVerdict` writes one when a review
 * is commissioned and this only reads it back, so the path a live agent was handed
 * cannot move under it. The `??` branch is the pre-#26 derivation and is reached only
 * by a record that entered this change mid-review; it is also what every non-verdict,
 * non-artifact row still gets, because nothing ever reserves for those.
 *
 * `adoptableArtifacts` still filters by prefix rather than by the `claimed` set: it
 * runs for artifact rows only, so the filter is what keeps a review out of an
 * artifact slot.
 */
export function artifactPathFor(run: Run, task: Task | null): string | null {
  if (task) {
    const row = taskRow(task.phase)
    if (row.artifact) return task.artifacts[row.artifact]
    return verdictFor(task, task.phase)
      ?? verdictFilename(verdictPrefix(run, task), task.phase, counterFor(task, task.phase))
  }
  return verdictFor(run, run.phase)
    ?? verdictFilename(verdictPrefix(run, null), run.phase, counterFor(run, run.phase))
}

/** Task artifacts live in the worker's linked worktree; run artifacts in the main checkout. */
export function absoluteArtifactPath(run: Run, task: Task | null): string | null {
  const rel = artifactPathFor(run, task)
  if (rel === null) return null
  return join(artifactBase(run, task), rel)
}

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
 *
 * A doc a merge commit added relative to its first parent came from the other
 * side, so it is subtracted even when no mainline ref knows that side — a worker
 * merging a sibling's branch, or a fork whose remote is not `origin`.
 *
 * Two residuals, both failing closed to a repair. A branch with nothing of its
 * own that fast-forwards onto a ref no mainline contains is indistinguishable from
 * its own work. And a doc the worker commits inside a conflict-resolving merge
 * (`git add -A` with its artifact uncommitted) is subtracted as foreign.
 */
export async function adoptableArtifacts(
  checkoutPath: string | null, claimed: Set<string>, batchBranch: string | null = null,
): Promise<string[]> {
  // Adoption is a worktree-scoped repair. With no checkout the scan would run
  // against the main checkout, shared with the orchestrator, the run-level
  // branch-review artifact and every sibling's merged docs.
  if (checkoutPath === null) return []

  const mainlines: string[] = []
  for (const ref of await mainlineRefs(checkoutPath, batchBranch)) {
    const resolved = await git(checkoutPath, ['rev-parse', '--verify', '--quiet', ref])
    if (resolved.code === 0) mainlines.push(ref)
  }
  if (mainlines.length === 0) return []

  const forkPoint = await git(checkoutPath, ['merge-base', 'HEAD', ...mainlines])
  if (forkPoint.code !== 0) return []

  const diff = await git(checkoutPath, [
    'diff', '-z', '--name-only', '--diff-filter=A', forkPoint.text.trim(), 'HEAD', '--', 'docs/',
  ])
  if (diff.code !== 0) return []

  const mergedIn = await git(checkoutPath, mergeAddedDocsArgs(mainlines))
  if (mergedIn.code !== 0) return []
  const addedByMerges = new Set(nulSeparated(mergedIn.text))

  return nulSeparated(diff.text)
    .filter((path) => !path.startsWith(`${REVIEWS_DIR}/`))
    .filter((path) => !addedByMerges.has(path))
    .filter((path) => !claimed.has(path))
}

/**
 * The mainline a worker worktree forks from. Dispatch cuts it from the fetched
 * `origin/<default>` commit (`freshDispatchBase`) and the pre-merge step merges
 * `origin/<default>`, while the local branch is often stale, so both refs count:
 * against the local branch alone the merge-base stays behind and every doc that
 * landed meanwhile reads as added. Measured on this repo: six sibling-owned
 * candidates.
 *
 * The default branch comes from dispatch's own detection, so adoption cannot
 * measure against a different branch than the worktree was cut from (#108).
 *
 * A base pinned at dispatch would not help. Whatever the base, the diff runs to
 * HEAD's tree, and merging the default branch puts the siblings' docs in that tree.
 *
 * A single-PR run's batch branch is a mainline too: its worktrees are cut from it.
 */
async function mainlineRefs(checkoutPath: string, batchBranch: string | null): Promise<string[]> {
  const branch = await mainlineBranch(checkoutPath, (reason) => warnToTick(
    `adoption offers no candidates in ${checkoutPath}: origin's default branch is unknown (${reason})`,
  ))
  if (branch === null) return []
  const batch = batchBranch === null ? [] : [`refs/heads/${batchBranch}`, `refs/remotes/origin/${batchBranch}`]
  return [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`, ...batch]
}

// `-m --first-parent`, not `--diff-merges=first-parent`: the latter needs git 2.31,
// and on an older git the log exits non-zero and silently turns adoption off.
export function mergeAddedDocsArgs(mainlines: string[]): string[] {
  return [
    'log', '-z', '--format=', '--name-only', '--diff-filter=A',
    '--first-parent', '--merges', '-m',
    'HEAD', '--not', ...mainlines, '--', 'docs/',
  ]
}

function nulSeparated(text: string): string[] {
  return text.split('\0').filter((path) => path.length > 0)
}

/**
 * Porcelain paths the checkout has not committed, or null when git could not
 * answer — an unreadable checkout must not read as a clean one.
 */
export async function uncommittedPaths(checkoutPath: string): Promise<string[] | null> {
  const status = await git(checkoutPath, ['status', '--porcelain=v1', '--untracked-files=normal'])
  if (status.code !== 0) return null
  return status.text
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
}

/**
 * A task is owed a worktree once it has left `queued` — at registration or when
 * its dependencies land — until it is bound or has stopped. A queued dependent is
 * not owed one yet: holding `dispatch` for it would stall-probe the orchestrator
 * for the whole life of its dependency.
 */
function awaitsWorktree(task: Task): boolean {
  if (task.phase === 'queued' || task.workspace_id !== null) return false
  return !taskRow(task.phase).terminal && task.phase !== 'escalated'
}

/**
 * #152. `intake → dispatch` waits for the orchestrator to go idle, and `hpipe task`
 * dispatches at registration, so the orchestrator usually registers, dispatches
 * and closes intake in the turn that gate waits out. The prompt then arrived
 * asking it to keep registering and to run `dispatch --done`, both already done,
 * and it spent a turn on it. Measured on a live run. A queued task is owed nothing
 * yet: it arrives as its own `Dispatch tN` prompt, block and all, once it can start.
 */
function owedDispatch(task: Task): boolean {
  return awaitsWorktree(task) || task.awaiting_brief === true
}

function nothingToDispatch(run: Run): string {
  const queued = run.tasks.filter((task) => task.phase === 'queued').map((task) => task.task_id)
  if (queued.length === 0) return 'Every task registered so far has its worktree and its brief: nothing to dispatch now.'
  return 'Every task that can start has its worktree and its brief: nothing to dispatch now. ' +
    `${queued.join(', ')} ${queued.length === 1 ? 'is' : 'are'} queued; each arrives as its own \`Dispatch tN\` ` +
    'prompt, carrying its dispatch block, once it can start.'
}

export function taskSignalsFor(run: Run) {
  return {
    newestRegisteredAt: run.tasks.length > 0
      ? Math.max(...run.tasks.map((t) => t.registered_at))
      : null,
    dispatchComplete: run.tasks.some((t) => t.phase !== 'queued') &&
      !run.tasks.some(awaitsWorktree),
    tasksAllTerminal: run.tasks.length > 0 && run.tasks.every((t) => FINISHED.has(t.phase)),
    landedTaskCount: run.tasks.filter(hasLanded).length,
  }
}

export type RunGh = Pick<Gh, 'prForBranch' | 'prView' | 'prChecksDetail'>

/** The batch PR as gh reads it now; null when none is open, or a read failed, which skips the row this tick. */
async function readBatchPr(batch: Batch, gh: RunGh): Promise<BatchPr | null> {
  const number = batch.pr ?? (await gh.prForBranch(batch.branch))
  if (number === null) return null
  const view = await gh.prView(number)
  if (view === null) return null
  return {
    number, headSha: view.headSha, merged: view.merged, mergedAtMs: view.mergedAtMs,
    mergeCommit: view.mergeCommit ?? null,
  }
}

const READS_THE_BATCH_PR: ReadonlySet<string> = new Set(['ship', 'ship-merge'])

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
  run: Run, gh: RunGh, config: Config, liveIdle: (paneId: string) => Promise<boolean>,
  extras: RunRenderExtras = {}, holdForSubagents?: SubagentHold,
): Promise<{ advanced: boolean; nextPrompt: string; phaseNote: string }> {
  const stay = { advanced: false, nextPrompt: '', phaseNote: '' }
  const pane = run.orchestrator_pane
  if (!pane) return stay

  const signal = runRow(run.phase).signal
  const actorIdle = await liveIdle(pane)
  let pastSubagents: readonly string[] | null = null

  let artifactFresh = false
  let verdict: VerdictResult | null = null

  if (signal === 'artifact' || signal === 'verdict') {
    if (!actorIdle) return stay

    const absolute = absoluteArtifactPath(run, null)
    if (!absolute) return stay

    if (!(await isFresh(absolute, run.phase_entered_at))) return stay
    if (!(await isSettled(absolute, config.FILE_SETTLE_MS))) return stay
    // A branch review the orchestrator handed to a subagent is written while it sits
    // idle at its prompt, and on a CLEAR it fixes the findings once the subagent
    // reports back: read before then, the ship prompt overtook both.
    if (holdForSubagents !== undefined) {
      const call = await holdForSubagents(holdKey(run, null), pane)
      if (call.hold) return stay
      pastSubagents = call.past ?? null
    }

    artifactFresh = true
    verdict = await parseVerdict(absolute)
  }

  const batch = run.batch
  const readsPr = batch !== undefined &&
    (READS_THE_BATCH_PR.has(run.phase) || (run.phase === 'ship-ci' && batch.ci === 'fail'))
  const batchPr = readsPr ? await readBatchPr(batch, gh) : undefined

  const before = run.phase
  const advanced = advanceRun(run, {
    actorIdle, artifactFresh, verdict, maxPasses: config.MAX_PASSES,
    ...taskSignalsFor(run), batchPr,
  })
  if (!advanced) return stay
  notePastSubagents(run, before, pastSubagents)

  const nextPrompt = await promptForRunPhase(run, config, { ciDetail: (pr) => gh.prChecksDetail(pr), ...extras })
  return { advanced: true, nextPrompt, phaseNote: ` → ${run.phase} (from ${before})` }
}

const UNLANDED_MEANING: Partial<Record<TaskPhase, string>> = {
  'failed': 'its work never merged',
  'orphaned': 'it merged, but its worktree was not removed; its code is on the base branch',
  'escalated': 'it is waiting on a human and its work has not merged',
}

/**
 * Read off `landed`, not `merged_at_ms`: a task that landed and was then rewound
 * and abandoned has no merge recorded, yet its commits are on the batch branch.
 */
function unlandedMeaning(run: Run, task: Task, batch: Batch): string {
  if ((task.landed ?? []).length > 0) return `it landed on \`${batch.branch}\` before it stopped`
  if (task.phase === 'blocked-on-failure') return neverStarted(run, task)
  if (task.phase === 'escalated') return `it is waiting on a human and has not landed on \`${batch.branch}\``
  return `its work never landed on \`${batch.branch}\``
}

/**
 * Gating before #46 cascaded the dependents of an escalated task too, and that
 * phase is terminal, so a run on disk can hold one whose dependency was later
 * resumed and landed. Name the dependency's real outcome rather than "failed".
 */
function neverStarted(run: Run, task: Task): string {
  const unlanded = task.depends_on.filter((id) => {
    const dep = run.tasks.find((t) => t.task_id === id)
    return dep === undefined || dep.phase !== 'done'
  })
  return unlanded.length > 0
    ? `it never started, because ${unlanded.join(', ')} did not land`
    : 'it never started: it was blocked on a dependency that has since landed, and was never re-queued'
}

/**
 * The final review's opening claim about the batch. A fixed "every task is
 * merged" sent a reviewer after a task whose branch held no source change at
 * all. Measured on a live run.
 */
export function taskOutcomesFor(run: Run): string {
  const batch = run.batch
  if (batch !== undefined) return batchOutcomes(run, batch)
  const unlanded = run.tasks.filter((t) => t.phase !== 'done')
  if (unlanded.length === 0) return `Every task in **${run.title}** is merged and torn down.`
  const lines = unlanded.map((t) =>
    `- \`${t.task_id}\` (${t.bead}, \`${t.branch}\`) stopped at \`${t.phase}\`` +
    ` — ${t.phase === 'blocked-on-failure' ? neverStarted(run, t) : UNLANDED_MEANING[t.phase] ?? 'it did not finish'}`)
  return [
    `Not every task in **${run.title}** landed. Every task is merged and torn down except:`,
    '',
    ...lines,
    '',
    'Review what is on the base branch. Do not report the absence of work that never merged ' +
    'as a finding against the tasks that did — the human already knows these stopped.',
  ].join('\n')
}

function batchOutcomes(run: Run, batch: Batch): string {
  const unlanded = run.tasks.filter((t) => t.phase !== 'done')
  if (unlanded.length === 0) return `Every task in **${run.title}** has landed on \`${batch.branch}\` and is torn down.`
  return [
    `Not every task in **${run.title}** landed on \`${batch.branch}\`. Every task has landed and is torn down except:`,
    '',
    ...unlanded.map((t) =>
      `- \`${t.task_id}\` (${t.bead}, \`${t.branch}\`) stopped at \`${t.phase}\` — ${unlandedMeaning(run, t, batch)}`),
    '',
    'Review what is on the batch branch. Do not report the absence of work that never landed as a finding ' +
    'against the tasks that did — the human already knows these stopped.',
  ].join('\n')
}

/** What a run render needs beyond the ledger; the supervisor's are its environment and gh. */
export interface RunRenderExtras {
  stateDir?: string
  ciDetail?: (pr: number) => Promise<string>
  maxPasses?: number
  dispatches?: DispatchLocks
}

export async function promptForRunPhase(run: Run, config: Config, extras: RunRenderExtras = {}): Promise<string> {
  if (runRow(run.phase).signal === 'verdict') await reserveRunReview(run, warnToTick)
  return renderRunPhasePrompt(run, process.env.HERDR_PLUGIN_ROOT ?? process.cwd(), {
    maxPasses: config.MAX_PASSES, ...extras,
  })
}

/** Rewritten on every render, so the body always lists every landing so far. */
function writeShipFiles(stateDir: string, run: Run): { body: string; squash: string } {
  const body = batchPrBodyPath(stateDir, run)
  const squash = squashBodyPath(stateDir, run)
  mkdirSync(dirname(body), { recursive: true })
  writeFileSync(body, batchPrBody(run))
  writeFileSync(squash, squashBody(run))
  return { body, squash }
}

/**
 * The ship prompt is what has the batch checkout made, so it is read before the
 * checkout exists: read from nowhere then, it told smoke run 24 the repo declares
 * no check that `start` had just reported. Measured on a live run.
 */
function checkSentence(run: Run, batch: Batch): string {
  const check = repoCheck(existsSync(batch.checkout) ? batch.checkout : run.repo_root)
  return check.kind === 'none'
    ? `It fetches \`${batch.branch}\` and records the head of the checkout at it, but this repo declares no ` +
      `\`${CHECK_REL}\`: run the tests and the typecheck there yourself first.`
    : `It fetches \`${batch.branch}\`, runs \`${CHECK_REL}\` in \`${batch.checkout}\` at that head, and records ` +
      'the head it passed on.'
}

/** The ship steps fetch only the batch, so `origin/<into>` is as old as the last fetch of it, which may be the start. */
function intoConflictCheck(batch: Batch): string {
  const checkout = shellQuoted(batch.checkout)
  return `git -C ${checkout} fetch origin ${shellWord(trackingRefspec(batch.into))} && git -C ${checkout} ` +
    `merge-tree --write-tree ${shellWord(`origin/${batch.into}`)} ${shellWord(`origin/${batch.branch}`)}`
}

/**
 * Start's answer, not a fresh one: a ship prompt is also rendered by a rewind, inside
 * a save's stale-retry, where a gh call could outlast every retry.
 */
function rulesetAdvice(batch: Batch): string {
  if (batch.ruleset_protected === true) return ''
  return ` If \`${rulesetPattern(batch.branch)}\` has no ruleset blocking force-pushes and deletion, recommend ` +
    'one to the user (GitHub → Settings → Rules → Rulesets): without it, a `--force` push gets past the ' +
    'landing gate.'
}

/**
 * As the per-task merge prompt's: pinned to the head the pass was read on, so a push
 * between the prompt and the merge makes GitHub refuse it. The batch merge carried
 * no guard, and a push reaches `ship-ci` only at the supervisor's next fetch.
 * Measured on a live run.
 */
function greenHeadVars(batch: Batch): { green_head: string; pinned: string; match_head: string } {
  const passedOn = batch.ci === 'pass' ? batch.ci_head?.sha : undefined
  if (passedOn === undefined) return { green_head: 'the head CI ran on', pinned: '', match_head: '' }
  return {
    green_head: `\`${sha8(passedOn)}\`, the head CI ran on`,
    pinned: " The merge command merges only while the PR's head is still that commit.",
    match_head: ` --match-head-commit ${shellWord(passedOn)}`,
  }
}

function shipCiStatus(batch: Batch, pr: string): string {
  const what = `PR #${pr}, \`${batch.branch}\` into \`${batch.into}\`.`
  return batch.ci === 'pass' ? `CI is green on ${what} ` : `No green CI is recorded on ${what} ${ciCheckFirst(pr)}\n`
}

async function shipPrompt(run: Run, batch: Batch, pluginRoot: string, extras: RunRenderExtras): Promise<string> {
  const stateDir = extras.stateDir ?? process.env.HERDR_PLUGIN_STATE_DIR ?? ''
  const { body, squash } = writeShipFiles(stateDir, run)
  const vars = {
    run_id: run.run_id, batch: batch.branch, into: batch.into, pr: String(batch.pr ?? 'unknown'),
    checkout: batch.checkout, checkout_quoted: shellQuoted(batch.checkout), implement_model: IMPLEMENT_MODEL,
    body_path: body, body_file: shellQuoted(body), squash_body_file: shellQuoted(squash),
    subject: shellQuoted(squashSubject(run)),
  }
  if (run.phase === 'ship-merge') {
    const owed = owedAt(run, null)
    if (owed.length > 0) {
      return renderPrompt(pluginRoot, 'before-merge', batchHoldVars(run, batch, owed, hpipeCommand(pluginRoot)))
    }
    return renderPrompt(pluginRoot, 'ship-merge', {
      ...vars, ci_status: shipCiStatus(batch, vars.pr), ...greenHeadVars(batch), before_merge: rulingsNote(run),
    })
  }
  const steps = checkoutSteps(run, existsSync(batch.checkout)).map((step) => `       ${step}`).join('\n')
  // `ship-ci` also sends a head pushed past the check back here, and that is no red to repair.
  const cameFromRedCi = run.history.findLast((h) => h.task_id === undefined)?.from === 'ship-ci' && batch.ci === 'fail'
  if (cameFromRedCi && batch.pr !== null) {
    return renderPrompt(pluginRoot, 'ship-ci-red', {
      ...vars, checkout_steps: steps, ci_failure: (await extras.ciDetail?.(batch.pr)) ?? '',
      pass: String(counterFor(run, 'ship-ci')), max_passes: String(extras.maxPasses ?? 2),
    })
  }
  return renderPrompt(pluginRoot, 'ship', {
    ...vars, checkout_steps: steps, check_sentence: checkSentence(run, batch), into_conflict_check: intoConflictCheck(batch),
    ruleset_advice: rulesetAdvice(batch),
    pr_command: batch.pr === null
      ? `gh pr create --base ${shellWord(batch.into)} --head ${shellWord(batch.branch)} ` +
        `--title ${shellQuoted(suggestedPrTitle(run))} ` +
        `--body-file ${shellQuoted(body)}`
      : `gh pr edit ${batch.pr} --body-file ${shellQuoted(body)}`,
  })
}

/** The run's phase prompt against the verdict path already reserved; see `renderTaskPhasePrompt`. */
export async function renderRunPhasePrompt(
  run: Run, pluginRoot: string, extras: RunRenderExtras = {},
): Promise<string> {
  const verdictPath = absoluteArtifactPath(run, null) ?? join(run.repo_root, 'review.md')

  const common = {
    ...runChangeVars(run, hpipeCommand(pluginRoot)),
    run_id: run.run_id, title: run.title,
    pass: String(counterFor(run, run.phase)),
    verdict_path: verdictPath,
    repo_root: run.repo_root,
    task_tiers: taskTiers(run),
  }

  switch (run.phase) {
    case 'intake': return renderPrompt(pluginRoot, 'intake', common)
    case 'dispatch': {
      const queued = run.tasks.some((task) => task.phase === 'queued')
      if (run.intake_closed && !queued && !run.tasks.some(owedDispatch)) return ''
      const registering = run.intake_closed ? '' : await renderPrompt(pluginRoot, 'dispatch-registering', common)
      if (!run.tasks.some(owedDispatch)) {
        return [`# Dispatch — run ${run.run_id}`, nothingToDispatch(run), registering.trimEnd()]
          .filter((part) => part.length > 0).join('\n\n')
      }
      const running = runDispatchUnderWay(extras.dispatches ?? NO_DISPATCHES, run)
      const text = await renderPrompt(pluginRoot, 'dispatch', {
        ...common, registering,
        dispatch_running: running === null ? '' : dispatchRunningLine(running, hpipeCommand(pluginRoot), Date.now()),
      })
      return text.replace(/\n{3,}/g, '\n\n')
    }
    case 'branch-review': return renderPrompt(pluginRoot, 'branch-review', {
      ...common, task_outcomes: taskOutcomesFor(run), review_effort: branchReviewEffort(run),
    })
    case 'escalated': {
      const from = run.escalated_from ?? run.phase
      return renderPrompt(pluginRoot, 'escalate', {
        run_id: run.run_id, phase: from,
        pass: String(counterFor(run, from)),
        resume_command: resumeCommand(hpipeCommand(pluginRoot), run),
        abandon: '',
      })
    }
    case 'ship':
    case 'ship-merge':
      return run.batch === undefined ? '' : shipPrompt(run, run.batch, pluginRoot, extras)
    case 'done': return run.batch === undefined ? perTaskDoneNotice(run) : batchDoneNotice(run, run.batch)
    default: return ''
  }
}

/**
 * `done` has no prompt of its own, and since #143 a run reaches it straight from
 * `execute` when at most one task landed, so the orchestrator was told nothing
 * when its run ended. Measured on a live run.
 */
function runDoneNotice(run: Run): string {
  const why = run.history.findLast((h) => h.task_id === undefined && h.to === 'done')?.why
  return [
    `Run ${run.run_id} is done${why === undefined ? '' : ` — ${why}`}. Nothing more is sent for it.`,
    ...run.tasks.map((t) => `- ${t.task_id} ${t.branch} (${t.bead}): ${t.phase}${mergedPrNote(t)}`),
    ...beforeMergeOutcome(run),
  ].join('\n')
}

/** A run reaches `done` with a check owed only by a human's rewind or abort, and then says so. */
function beforeMergeOutcome(run: Run): string[] {
  const checks = checksIn(run)
  if (checks.length === 0) return []
  return [`before merge: ${checks.map((held) => {
    const state = checkState(run, held)
    return `${checkName(held)} ${isOwed(state) ? `still owed to the human: ${held.check.check}` : stateClause(state)}`
  }).join(' · ')}`]
}

const mergedPrNote = (task: Task): string => (hasLanded(task) && task.pr !== null ? `, PR #${task.pr} merged` : '')

async function perTaskDoneNotice(run: Run): Promise<string> {
  const merged = run.tasks.filter((t) => hasLanded(t) && t.pr !== null)
  const repo = shellQuoted(run.repo_root)
  const leftovers = [
    ...(await mergedBranchLines(run, merged, repo)), ...(await mergedMainlineLines(run, merged, repo)),
    ...(await staleRemoteRefLines(run, repo, merged.map((t) => t.branch))),
  ]
  return [
    runDoneNotice(run), ...(leftovers.length === 0 ? [] : ['Clean up when you are done with it:', ...leftovers]),
  ].join('\n')
}

/**
 * GitHub deletes a merged PR's head branch only when the repo is set to, and
 * herdr's worktree removal keeps the local one. A squash merge leaves none of a
 * branch's commits on the default branch, so only a branch still at the head its
 * PR merged is safe to delete: `merge` holds that head to the one CI passed on.
 */
async function mergedBranchLines(run: Run, merged: Task[], repo: string): Promise<string[]> {
  const remoteDeletable: string[] = []
  const localDeletable: string[] = []
  const remoteKept: string[] = []
  const localKept: string[] = []
  for (const task of merged) {
    const mergedHead = task.ci_head?.sha ?? null
    const unmerged = async (where: string, sha: string) => mergedHead === null
      ? `  ${where} is at ${sha8(sha)}, and the head PR #${task.pr} merged is not on record; check before deleting`
      : `  ${where} ${await commitsNotOn(run.repo_root, sha, mergedHead, `PR #${task.pr} did not merge`)}; ` +
        'review before deleting'
    const remote = await remoteBranchHeadCooled(run.repo_root, task.branch)
    if (!remote.ok) {
      remoteKept.push(`  ${task.branch} could not be read on origin (${remote.reason}); review it before deleting`)
    } else if (remote.sha !== null) {
      if (remote.sha === mergedHead) remoteDeletable.push(task.branch)
      else remoteKept.push(await unmerged(`${task.branch} on origin`, remote.sha))
    }
    // A kept worktree still has its branch checked out, and `branch -D` refuses that.
    if (task.checkout_path !== null && existsSync(task.checkout_path)) continue
    const local = await resolveCommit(run.repo_root, `refs/heads/${task.branch}`)
    if (local === null) continue
    if (local === mergedHead) localDeletable.push(task.branch)
    else localKept.push(await unmerged(`local ${task.branch}`, local))
  }
  const deleteLine = (command: string, branches: string[]) =>
    (branches.length === 0 ? [] : [`  git -C ${repo} ${command} ${branches.map(shellWord).join(' ')}`])
  return [
    ...deleteLine('push origin --delete', remoteDeletable), ...remoteKept,
    ...deleteLine('branch -D', localDeletable), ...localKept,
  ]
}

/** The latest merge stands for every earlier one: the default branch's history is linear. */
async function mergedMainlineLines(run: Run, merged: Task[], repo: string): Promise<string[]> {
  const latest = merged
    .filter((t): t is Task & { merge_commit: string } => typeof t.merge_commit === 'string')
    .sort((a, b) => (b.merged_at_ms ?? 0) - (a.merged_at_ms ?? 0))[0]
  if (latest === undefined) return []
  const mainline = await mainlineBranch(run.repo_root)
  if (mainline === null) return []
  return staleBranchLines(run, repo, mainline, latest.merge_commit, `PR #${latest.pr}'s merge`)
}

/**
 * GitHub deletes only a PR's own head branch on merge, so the task branches are
 * left to the orchestrator — but only a branch whose head is on the batch is
 * safe to delete: anything pushed to it after its reviewed head never landed.
 */
export async function cleanupLines(run: Run, batch: Batch): Promise<string[]> {
  return ['Clean up when you are done with it:', ...(await batchCleanup(run, batch))]
}

async function batchCleanup(run: Run, batch: Batch): Promise<string[]> {
  const batchRef = `refs/remotes/origin/${batch.branch}`
  const deletable: string[] = []
  const kept: string[] = []
  for (const task of run.tasks) {
    const remote = await remoteBranchHeadCooled(run.repo_root, task.branch)
    if (!remote.ok) {
      kept.push(`  ${task.branch} could not be read on origin (${remote.reason}); review it before deleting`)
      continue
    }
    if (remote.sha === null) continue
    const landed = await isAncestor(run.repo_root, remote.sha, batchRef)
    if (landed === true) {
      deletable.push(task.branch)
    } else if (landed === false) {
      const notLanded = await commitsNotOn(run.repo_root, remote.sha, batchRef, 'that did not land')
      kept.push(`  ${task.branch} on origin ${notLanded}; review before deleting`)
    } else {
      kept.push(`  ${task.branch} is at ${sha8(remote.sha)}, which could not be compared with ${batch.branch} here; ` +
        'fetch it and check before deleting')
    }
  }
  const repo = shellQuoted(run.repo_root)
  return [
    ...(deletable.length === 0 ? [] : [`  git -C ${repo} push origin --delete ${deletable.map(shellWord).join(' ')}`]),
    ...kept,
    ...await checkoutRemovalLines(run.repo_root, batch.checkout, repo),
    ...await localBatchLines(run, batch, batchRef, repo),
  ]
}

/** `branch -D` forces, so only a branch origin already holds: a ship repair committed but never pushed lives only here. */
async function localBatchLines(run: Run, batch: Batch, batchRef: string, repo: string): Promise<string[]> {
  const local = await resolveCommit(run.repo_root, `refs/heads/${batch.branch}`)
  if (local === null) return []
  const pushed = await isAncestor(run.repo_root, local, batchRef)
  if (pushed === true) return [`  git -C ${repo} branch -D ${shellWord(batch.branch)}`]
  if (pushed === false) {
    return [`  local ${batch.branch} ${await commitsNotOn(run.repo_root, local, batchRef, `not on origin/${batch.branch}`)}; ` +
      'review before deleting']
  }
  return [`  local ${batch.branch} is at ${sha8(local)}, which could not be compared with origin/${batch.branch}; check ` +
    'before deleting']
}

/** The tip alone read as the one commit that did not land. Measured on a live run. */
async function commitsNotOn(repoRoot: string, sha: string, base: string, what: string): Promise<string> {
  const counted = await git(repoRoot, ['rev-list', '--count', `${base}..${sha}`])
  const count = counted.code === 0 ? Number.parseInt(counted.text.trim(), 10) : Number.NaN
  const commits = Number.isNaN(count) ? 'commits' : `${count} commit${count === 1 ? '' : 's'}`
  return `has ${commits} ${what}, up to ${sha8(sha)}`
}

const nonEmptyLines = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)

const sample = (paths: readonly string[]): string => `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}`

/**
 * git refuses to remove a worktree with initialised submodules unless forced, and
 * the ship prompts have the orchestrator bootstrap the batch checkout, which is how
 * a repo that vendors an SDK as a submodule gets them. Measured on a live run.
 * `--force` deletes a linked worktree's submodule git data and any uncommitted work
 * with it, so it is offered only when nothing there is unrecorded: no uncommitted
 * work, every initialised submodule at the commit the checkout records, and that
 * commit on one of the submodule's remote branches.
 */
async function checkoutRemovalLines(repoRoot: string, checkout: string, repo: string): Promise<string[]> {
  const remove = `  git -C ${repo} worktree remove`
  const quoted = shellQuoted(checkout)
  // The prompts create it only at ship, so a run aborted before then has none.
  if (!existsSync(checkout)) {
    return await gitListsWorktree(repoRoot, checkout)
      ? [`  git -C ${repo} worktree prune  # ${checkout} is gone, but git still lists it`]
      : []
  }
  const submodules = await git(checkout, ['submodule', 'status', '--recursive'])
  const initialised = nonEmptyLines(submodules.text).filter((line) => !line.startsWith('-'))
  if (submodules.code === 0 && initialised.length === 0) return [`${remove} ${quoted}`]
  const pathOf = (line: string): string => line.slice(1).trim().split(' ')[1] ?? line
  const moved = initialised.filter((line) => line.startsWith('+') || line.startsWith('U')).map(pathOf)
  const status = await git(checkout, ['status', '--porcelain', '--ignore-submodules=none'])
  const unpushed = await git(checkout, ['submodule', 'foreach', '--quiet', '--recursive',
    'git branch -r --contains HEAD | grep -q . || echo "$displaypath"'])
  const reasons = [
    ...(submodules.code !== 0 || status.code !== 0 || unpushed.code !== 0 ? ['work git could not read'] : []),
    ...(nonEmptyLines(status.text).length > 0
      ? [`uncommitted work (${sample(nonEmptyLines(status.text).map((line) => line.slice(3)))})`]
      : []),
    ...(moved.length > 0 ? [`submodules not at the commit it records (${sample(moved)})`] : []),
    ...(nonEmptyLines(unpushed.text).length > 0
      ? [`submodule commits on no remote branch (${sample(nonEmptyLines(unpushed.text))})`]
      : []),
  ]
  if (reasons.length === 0) {
    return [`${remove} --force ${quoted}  # git refuses its submodules without --force; nothing in them is unpushed`]
  }
  return [`${remove} ${quoted}`, `  ${checkout} has ${reasons.join('; ')}: review it before adding --force, which ` +
    'its submodules need and which deletes their git data in this checkout']
}

/** git lists a worktree by its real path, and macOS puts temporary directories behind a symlink. */
async function gitListsWorktree(repoRoot: string, checkout: string): Promise<boolean> {
  const listed = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return false
  const parent = dirname(checkout)
  const spellings = [checkout, ...(existsSync(parent) ? [join(realpathSync(parent), basename(checkout))] : [])]
  return nonEmptyLines(listed.text).some((line) => spellings.some((path) => line === `worktree ${path}`))
}

/**
 * What an aborted run leaves, for a human who will not resume it. The abort once
 * offered to remove a batch checkout and branch that were never created, and said
 * nothing of the task worktrees and the agents still running in them. Measured on
 * a live run.
 */
export async function abortCleanupLines(run: Run, hpipe: string): Promise<string[]> {
  const repo = shellQuoted(run.repo_root)
  const worktrees = await taskWorktreeLines(run, repo)
  const lines = [
    ...worktrees.lines,
    ...(await abortLocalBranchLines(run, repo, worktrees.kept)),
    ...(run.batch === undefined
      ? await perTaskAbortLines(run, repo)
      : [...(await batchCleanup(run, run.batch)), ...(await abortedBatchLines(run, run.batch, repo))]),
    ...releasedBeadLines(run),
  ]
  return lines.length === 0 ? [] : [abortCleanupHead(hpipe), ...lines]
}

/**
 * Printed as the stop notices are queued, while each worker still finishes the
 * tool call it is in: a checkout read clean here was dirty by the time herdr was
 * asked to remove it. Measured on a live run. A second abort reads it afresh.
 */
export const abortCleanupHead = (hpipe: string): string =>
  `If you will not resume it, clean up once its workers have stopped (a second \`${hpipe} abort\` prints this ` +
  'again, read afresh):'

/**
 * herdr's worktree removal keeps the branch, and a commit a worker made but never
 * pushed is only there: the smoke run's implementation commits were. Measured on
 * a live run. A branch whose checkout stays is left to that checkout's line.
 */
async function abortLocalBranchLines(run: Run, repo: string, kept: ReadonlySet<string>): Promise<string[]> {
  const deletable: string[] = []
  const unpushed: string[] = []
  for (const task of run.tasks) {
    // A merged PR's branches are the lines `mergedBranchLines` gives, against the head it merged.
    if (kept.has(task.task_id) || (run.batch === undefined && hasLanded(task) && task.pr !== null)) continue
    const head = await resolveCommit(run.repo_root, `refs/heads/${task.branch}`)
    if (head === null) continue
    const counted = await git(run.repo_root, ['rev-list', '--count', head, '--not', '--remotes=origin'])
    const only = counted.code === 0 ? Number.parseInt(counted.text.trim(), 10) : Number.NaN
    if (only === 0) {
      deletable.push(task.branch)
    } else {
      const commits = Number.isNaN(only) ? 'commits' : `${only} commit${only === 1 ? '' : 's'}`
      unpushed.push(`  local ${task.branch} has ${commits} no branch on origin has, up to ${sha8(head)}; push it or ` +
        'review before deleting')
    }
  }
  return [
    ...(deletable.length === 0 ? [] : [`  git -C ${repo} branch -D ${deletable.map(shellWord).join(' ')}  # origin ` +
      `has every commit on ${deletable.length === 1 ? 'it' : 'them'}`]),
    ...unpushed,
  ]
}

/** Released beads come back as `hpipe next` picks, beside any bead filed for the same work before. */
function releasedBeadLines(run: Run): string[] {
  const released = run.tasks.filter((t) => !hasLanded(t) && (t.landed ?? []).length === 0 && !taskRow(t.phase).terminal)
  if (released.length === 0) return []
  const one = released.length === 1
  return [`  ${one ? 'bead' : 'beads'} ${released.map((t) => t.bead).join(', ')} ${one ? 'stays' : 'stay'} open, ` +
    `labelled aborted: a later run adopts ${one ? 'it' : 'them'} with \`hpipe task --bead <id>\` rather than filing ` +
    `new ones, or the user closes ${one ? 'it' : 'them'}`]
}

/** Nothing of an aborted run reached the default branch, so the batch on origin is the only copy of every landing. */
async function abortedBatchLines(run: Run, batch: Batch, repo: string): Promise<string[]> {
  const onOrigin = await remoteBranchHeadCooled(run.repo_root, batch.branch)
  if (!onOrigin.ok) {
    return [`  ${batch.branch} could not be read on origin (${onOrigin.reason}); keep it until you have checked it`]
  }
  if (onOrigin.sha === null) return []
  const landed = run.tasks.filter((t) => (t.landed ?? []).length > 0).map((t) => t.task_id)
  if (landed.length > 0) {
    return [`  origin keeps ${batch.branch}, the only copy of what ${landed.join(', ')} landed: keep it`]
  }
  if (await isAncestor(run.repo_root, onOrigin.sha, `refs/remotes/origin/${batch.into}`) !== true) {
    return [`  origin keeps ${batch.branch} at ${sha8(onOrigin.sha)}, which holds commits not on ${batch.into}; ` +
      'review before deleting']
  }
  if (batch.ruleset_protected === true) {
    return [`  origin keeps ${batch.branch}, which the ruleset on ${rulesetPattern(batch.branch)} protects from deletion: leave it`]
  }
  return [`  git -C ${repo} push origin --delete ${shellWord(batch.branch)}  # nothing landed on it; a ruleset on ` +
    `${rulesetPattern(batch.branch)} needs a bypass`]
}

/** herdr's removal closes the workspace's agent and, like git's, keeps the branch. */
/** `kept`: the tasks whose checkout stays until a human has reviewed it. */
async function taskWorktreeLines(run: Run, repo: string): Promise<{ lines: string[]; kept: Set<string> }> {
  const lines: string[] = []
  const kept = new Set<string>()
  for (const task of run.tasks) {
    const checkout = task.checkout_path
    if (checkout === null || !existsSync(checkout)) continue
    const removal = task.workspace_id === null
      ? `git -C ${repo} worktree remove ${shellQuoted(checkout)}`
      : `herdr worktree remove --workspace ${task.workspace_id}`
    const head = await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const branch = head.code === 0 ? head.text.trim() : null
    if (branch !== task.branch) {
      kept.add(task.task_id)
      lines.push(`  ${task.task_id}'s checkout ${checkout} is on ${branch ?? 'no branch'}, not ${task.branch}: review it ` +
        `before \`${removal}\``)
      continue
    }
    const uncommitted = await uncommittedPaths(checkout)
    if (uncommitted === null || uncommitted.length > 0) {
      kept.add(task.task_id)
      const what = uncommitted === null ? 'work git could not read' : `uncommitted work (${sample(uncommitted)})`
      lines.push(`  ${task.task_id}'s checkout ${checkout} has ${what}: review it before \`${removal}\``)
      continue
    }
    const agent = task.workspace_id === null ? '' : 'closes its agent and '
    lines.push(`  ${removal}  # ${task.task_id}'s checkout ${checkout}; ${agent}keeps ${task.branch}`)
  }
  return { lines, kept }
}

/** A merged task's branches are the done notice's; an unmerged one's hold the only copy of its work. */
async function perTaskAbortLines(run: Run, repo: string): Promise<string[]> {
  const merged = run.tasks.filter((t) => hasLanded(t) && t.pr !== null)
  const mainline = await mainlineBranch(run.repo_root)
  const unmerged: string[] = []
  for (const task of run.tasks.filter((t) => !merged.includes(t))) {
    const pr = task.pr === null ? '' : ` (PR #${task.pr}, left open)`
    const remote = await remoteBranchHeadCooled(run.repo_root, task.branch)
    if (!remote.ok) {
      unmerged.push(`  ${task.branch}${pr} could not be read on origin (${remote.reason}); review it before deleting`)
    } else if (remote.sha !== null) {
      const notOn = mainline === null ? `is at ${sha8(remote.sha)}`
        : await commitsNotOn(run.repo_root, remote.sha, `refs/remotes/origin/${mainline}`, `not on ${mainline}`)
      unmerged.push(`  ${task.branch} on origin${pr} ${notOn}; review before deleting`)
    } else if (task.pr !== null) {
      unmerged.push(`  PR #${task.pr} is left open, and origin no longer has ${task.branch}`)
    }
  }
  return [...(await mergedBranchLines(run, merged, repo)), ...unmerged]
}

/**
 * What a shipped run still leaves once the clean-up above is run: herdr's worktree
 * removal keeps each task's local branch, a ruleset keeps the batch on origin, the
 * user's default branch predates the squash merge, and the branch review stays in
 * the working copy, kept out of git. Measured on a live run.
 */
async function shippedLeftovers(run: Run, batch: Batch): Promise<string[]> {
  const repo = shellQuoted(run.repo_root)
  const squashMerge = `PR #${batch.pr ?? 'unknown'}'s squash merge`
  return [
    ...(await localTaskBranchLines(run, batch, repo)),
    ...(await staleBranchLines(run, repo, batch.into, batch.merge_commit, squashMerge)),
    ...(await originBatchLines(run, batch, repo)),
    ...(await staleRemoteRefLines(run, repo, [batch.branch, ...run.tasks.map((t) => t.branch)])),
    ...branchReviewLines(run),
  ]
}

/**
 * GitHub can delete a merged branch itself, and the clone keeps its `origin/` ref
 * until a fetch prunes it: the trial's batch was deleted on merge and
 * `origin/batch/…` stayed. Measured on a live run. A branch still on origin is
 * the other lines' to delete, which takes its ref with it.
 */
async function staleRemoteRefLines(run: Run, repo: string, branches: string[]): Promise<string[]> {
  const stale: string[] = []
  for (const branch of new Set(branches)) {
    if (await resolveCommit(run.repo_root, `refs/remotes/origin/${branch}`) === null) continue
    const onOrigin = await remoteBranchHeadCooled(run.repo_root, branch)
    if (onOrigin.ok && onOrigin.sha === null) stale.push(branch)
  }
  if (stale.length === 0) return []
  const refs = stale.map((branch) => shellWord(`origin/${branch}`)).join(' ')
  return [`  git -C ${repo} branch -dr ${refs}  # origin no longer has ${stale.length === 1 ? 'it' : 'them'}`]
}

/** Only a branch whose head is on the batch is safe to force-delete: a squash merge leaves none of them merged. */
async function localTaskBranchLines(run: Run, batch: Batch, repo: string): Promise<string[]> {
  const batchRef = `refs/remotes/origin/${batch.branch}`
  const deletable: string[] = []
  const kept: string[] = []
  for (const task of run.tasks) {
    // A kept worktree still has its branch checked out, and `branch -D` refuses that.
    if (task.checkout_path !== null && existsSync(task.checkout_path)) continue
    const head = await resolveCommit(run.repo_root, `refs/heads/${task.branch}`)
    if (head === null) continue
    const landed = await isAncestor(run.repo_root, head, batchRef)
    const local = `  local ${task.branch}`
    if (landed === true) deletable.push(task.branch)
    else if (landed === false) {
      kept.push(`${local} ${await commitsNotOn(run.repo_root, head, batchRef, 'that did not land')}; review before deleting`)
    } else kept.push(`${local} is at ${sha8(head)}, which could not be compared with ${batch.branch}; check before deleting`)
  }
  return [
    ...(deletable.length === 0 ? [] : [`  git -C ${repo} branch -D ${deletable.map(shellWord).join(' ')}`]),
    ...kept,
  ]
}

/** `pull` only on the branch checked out; any other is moved by fetch, which refuses anything but a fast-forward. */
async function staleBranchLines(
  run: Run, repo: string, branch: string, mergeCommit: string | null, merge: string,
): Promise<string[]> {
  if (mergeCommit !== null && await isAncestor(run.repo_root, mergeCommit, `refs/heads/${branch}`) === true) return []
  const current = await git(run.repo_root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const why = `  # ${branch} predates ${merge}`
  return [current.code === 0 && current.text.trim() === branch
    ? `  git -C ${repo} pull --ff-only${why}`
    : `  git -C ${repo} fetch origin ${shellWord(`${branch}:${branch}`)}${why}`]
}

async function originBatchLines(run: Run, batch: Batch, repo: string): Promise<string[]> {
  const onOrigin = await remoteBranchHeadCooled(run.repo_root, batch.branch)
  if (!onOrigin.ok || onOrigin.sha === null) return []
  if (batch.ruleset_protected === true) {
    return [`  origin keeps ${batch.branch}, which the ruleset on ${rulesetPattern(batch.branch)} protects from deletion: leave it`]
  }
  return [`  origin keeps ${batch.branch}, which is harmless; deleting it, ` +
    `\`git -C ${repo} push origin --delete ${shellWord(batch.branch)}\`, needs a bypass if a ruleset protects ` +
    rulesetPattern(batch.branch)]
}

/**
 * A run's review is its record, never committed, and sits in the user's working
 * copy, so it is excluded from git the moment it is reserved: left untracked there
 * it was one `git add -A` from shipping. Measured on a live run. The plugin writes
 * the exclusion itself rather than asking the orchestrator to touch git's files.
 */
export async function reserveRunReview(run: Run, warn: ReserveWarn): Promise<string> {
  const reserved = reserveVerdict(run, null, run.phase, warn)
  const refused = await excludeFromGit(run.repo_root, reserved)
  if (refused !== null) warn(`run ${run.run_id}: ${reserved} is not excluded from git: ${refused}`)
  return reserved
}

function branchReviewLines(run: Run): string[] {
  return Object.entries(run.artifacts.verdicts)
    .filter(([key]) => key.startsWith('branch-review-'))
    .map(([, rel]) => join(run.repo_root, rel))
    .filter((path) => existsSync(path))
    .map((path) => `  rm ${shellQuoted(path)}  # this run's branch review, kept out of git: delete it once you no ` +
      'longer need the record')
}

async function batchDoneNotice(run: Run, batch: Batch): Promise<string> {
  const shipped = batch.merged_at_ms !== null
  const outcome = shipped
    ? `shipped: PR #${batch.pr ?? 'unknown'} squash-merged as ${sha8(batch.merge_commit ?? 'unknown')}; ` +
      `${batch.into} now carries every landing`
    : `not shipped: nothing on ${batch.branch} reached ${batch.into}`
  return [
    runDoneNotice(run), outcome, ...(await cleanupLines(run, batch)),
    ...(shipped ? await shippedLeftovers(run, batch) : []),
  ].join('\n')
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
