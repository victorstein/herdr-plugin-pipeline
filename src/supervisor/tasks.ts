import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { answerCheckNote, checkFailedVars, lastFailure, owedAt, taskHoldVars, taskRulingsNote } from '../lib/before-merge'
import { bootstrapLine, repoBootstrap } from '../lib/bootstrap'
import { DEFAULT_STALL_MINUTES } from '../lib/config'
import {
  baseLine, dependencyMerges, type DispatchBase, fetchFromOrigin, type RemoteHead, remoteBranchHeadCooled,
  trackingRefspec,
} from '../lib/dispatch-base'
import { openDecisionFor } from '../lib/decisions'
import {
  gateStatus, landingQueue, landingSlotHolder, planDeclaredFiles, releasableFromFiles, separatePipelineArtifacts,
  widenFiles,
} from '../lib/gating'
import type { RunEffect } from '../lib/ledger'
import type { PrView } from '../lib/gh'
import {
  advanceTask, artifactFreshAfter, counterFor, enterTaskPhase, implementReady, type LandingFacts, landsWithoutSync,
  syncOverdue, syncSubmitted,
} from '../lib/machine'
import { briefAndPrompt, enqueue, owedItsPrompt, queuedWorkerPrompt } from '../lib/outbox'
import { modeOf, nextPhase, producedByActor, routeOf, taskRow } from '../lib/phases'
import { isFresh, isSettled, parseVerdict, type VerdictResult } from '../lib/predicates'
import { hpipeCommand, renderPrompt } from '../lib/render'
import { abandonParagraph, resumeCommand } from '../lib/status'
import { changePromptVars, heldSharedNote, landingPromptVars, mergePromptVars, syncPromptVars } from '../lib/change-prompt'
import { isSharedPath, sharedPrefixesOf } from '../lib/shared-paths'
import {
  ALWAYS_REVIEW_REL, alwaysReviewPrefixes, changeSize, type ReviewCall, reviewCall, type SkipCandidate, skipCandidacy,
} from '../lib/review-skip'
import { tierPromptVars } from '../lib/tier-prompt'
import { changedPaths, fileAt, type FileAtRef, isAncestor, landsNothing, numstat, resolveCommit } from '../lib/sync-walk'
import { artifactBase, REVIEWS_DIR, reserveVerdict } from '../lib/verdict-path'
import { dispatchSequence } from '../lib/unstarted'
import { beadPromptVars, renderWorkerPrompt } from '../lib/worker-prompt'
import type { Batch, ReviewSkip, Run, Task, TaskPhase } from '../lib/types'
import { absoluteArtifactPath, adoptableArtifacts, artifactPathFor, warnToTick } from './deliver'
import type { CheckSubmission } from './courier'
import { holdKey, notePastSubagents, type SubagentHold } from './pane-background'
import { runTeardown, type TeardownDeps } from './teardown'

export interface TaskDeps extends TeardownDeps {
  pluginRoot: string
  /**
   * Live `herdr agent status` read on a pane, already double-checked after
   * ACTOR_SETTLE_MS by the caller. NOT task.agent_status, which is the badge and
   * wake cache and can be stale by a whole turn.
   */
  liveIdle: (paneId: string) => Promise<boolean>
  /**
   * What Claude Code shows running in the background of the pane: subagents,
   * shells, monitors. Absent reads as nothing running.
   */
  backgroundWork?: (paneId: string) => Promise<readonly string[]>
  /** Whether a worker row whose signal is ready waits for a subagent still running; see `SubagentHolds`. */
  holdForSubagents?: SubagentHold
  /**
   * Whether herdr lists the pane with an agent in it. A pane with none never
   * reads idle, so without this an orchestrator-owned row is never evaluated
   * while the orchestrator is down.
   */
  hasLiveAgent: (paneId: string) => boolean
  maxPasses: number
  fileSettleMs: number
  prForBranch: (branch: string) => Promise<number | null>
  prView: (pr: number) => Promise<PrView | null>
  verdictFor: (run: Run, task: Task) => Promise<VerdictResult | null>
  /** Rendered detail of the failing checks, for the ci-red prompt. */
  ciDetail: (pr: number | null) => Promise<string>
  /**
   * Phase entries whose ambiguous candidate set has already been reported. Owned
   * by main()'s loop so cross-tick dedup has one owner, not a module-level twin.
   */
  ambiguityLog: Set<string>
  /** Collects what this tick did outside the ledger; see `saveOrReapply`. */
  effects?: RunEffect[]
  uncommittedPaths: (checkoutPath: string) => Promise<string[] | null>
  /** The commit a dispatched worktree is cut from; see lib/dispatch-base.ts. `branch` is a single-PR run's batch. */
  freshDispatchBase: (
    repoRoot: string, dependencyMerges: string[] | null, branch: string | null,
  ) => Promise<DispatchBase>
  /** Single-PR landing reads; the real ones read `repo_root`'s refs and ask origin for one branch head. */
  landingGit?: LandingGit
  /** How long a `sync` holder may go without submitting while another task waits to land. */
  syncYieldMs?: number
  /** Sizing a change for the PR review skip; the real ones read `repo_root`. */
  changeGit?: ChangeGit
}

export interface ChangeGit {
  numstat: (repoRoot: string, base: string, head: string) => Promise<string | null>
  fileAt: (repoRoot: string, ref: string, path: string) => Promise<FileAtRef>
}

export const LOCAL_CHANGE_GIT: ChangeGit = { numstat, fileAt }

export interface LandingGit {
  isAncestor: (repoRoot: string, ancestor: string, of: string) => Promise<boolean | null>
  remoteBranchHead: (repoRoot: string, branch: string) => Promise<RemoteHead>
  resolve: (repoRoot: string, ref: string) => Promise<string | null>
  changedPaths: (repoRoot: string, from: string, to: string) => Promise<string[] | null>
  fetch: (repoRoot: string, refspec: string) => Promise<string | null>
}

export const LOCAL_LANDING_GIT: LandingGit = {
  isAncestor, remoteBranchHead: (repoRoot, branch) => remoteBranchHeadCooled(repoRoot, branch),
  resolve: resolveCommit, changedPaths, fetch: fetchFromOrigin,
}

/** STALL_MINUTES, the orchestrator's cadence: a stuck sync holds up every landing behind it. */
const DEFAULT_SYNC_YIELD_MS = DEFAULT_STALL_MINUTES * 60_000

const UNCOMMITTED_SAMPLE = 3

/**
 * An idle worker with uncommitted work is the most common real stopped state, and
 * without this it reads exactly like one that is thinking. Measured on a live run.
 *
 * Only on a code row or a review row, whose verdict waits on a commit — the design
 * rows' artifacts are judged by the artifact signal — and only once per idle spell:
 * the worker has to go busy to change the tree, and going busy drops the record, so
 * the next idle spell checks afresh.
 */
async function noteUncommittedWork(
  run: Run, task: Task, actorIdle: boolean, deps: TaskDeps,
): Promise<void> {
  const row = taskRow(task.phase)
  const waitsOnCommits = row.holdsFiles === true || row.signal === 'verdict'
  if (row.actor !== 'worker' || !waitsOnCommits || task.checkout_path === null) return
  if (!actorIdle) {
    delete task.uncommitted_work
    return
  }
  if (queuedWorkerPrompt(run, task) !== null) return
  if (task.uncommitted_work?.at === task.phase_entered_at) return

  // An unreadable checkout is recorded as an empty observation, not skipped:
  // skipping would re-run git on every tick of the idle spell. It is retried on
  // the next spell, and it never reports as work waiting on anyone.
  const paths = (await deps.uncommittedPaths(task.checkout_path)) ?? []
  task.uncommitted_work = {
    at: task.phase_entered_at, count: paths.length, sample: paths.slice(0, UNCOMMITTED_SAMPLE),
  }
}

/**
 * The task-level counterpart to deliver.ts's promptForRunPhase. Without it the
 * state machine advances once an artifact exists but nothing ever asks the
 * orchestrator to produce one, so every task phase stalls.
 */
export async function promptForTaskPhase(
  run: Run, task: Task, deps: TaskDeps, cameFrom: TaskPhase,
): Promise<string> {
  // The commission happens here, not at the read: this is the one moment a task is
  // told where to write. Guarded on `signal`, not on a missing `artifact` — `ci`,
  // `merge`, `close` and `implement` also have no artifact slot and must not reserve.
  if (taskRow(task.phase).signal === 'verdict') reserveVerdict(run, task, task.phase, warnToTick)
  return renderTaskPhasePrompt(run, task, deps, cameFrom)
}

/**
 * The phase prompt against the verdict path already reserved. `cmdRewind` reserves
 * its own and prints it, so rendering through `promptForTaskPhase` there would burn
 * a second key and hand the agent a path the rewind did not name.
 */
export async function renderTaskPhasePrompt(
  run: Run, task: Task, deps: Pick<TaskDeps, 'pluginRoot' | 'ciDetail'>, cameFrom: TaskPhase,
): Promise<string> {
  const hpipe = hpipeCommand(deps.pluginRoot)
  const common = {
    ...tierPromptVars(run, task),
    ...(await changePromptVars(deps.pluginRoot, hpipe, run, task)),
    run_id: run.run_id,
    branch: task.branch,
    ...beadPromptVars(task),
    pr: task.pr === null ? 'unknown' : String(task.pr),
    pass: String(counterFor(task, task.phase)),
    verdict_path: absoluteArtifactPath(run, task) ?? '',
    title: run.title,
    research_path: taskArtifactPath(run, task, 'research'),
    spec_path: taskArtifactPath(run, task, 'spec'),
    plan_path: taskArtifactPath(run, task, 'plan'),
  }

  switch (task.phase) {
    case 'research':
    case 'spec':
    case 'spec-review':
    case 'plan':
    case 'plan-review':
      return renderPrompt(deps.pluginRoot, taskRow(task.phase).prompt as string, common)
    case 'pr-review':
      return renderPrompt(deps.pluginRoot, 'pr-review', common)
    case 'pr-review-intent':
      return renderPrompt(deps.pluginRoot, 'pr-review-intent', common)
    case 'pr-review-quality':
      return renderPrompt(deps.pluginRoot, 'pr-review-quality', common)
    case 'merge': {
      if (modeOf(run) === 'single-pr') {
        return renderPrompt(deps.pluginRoot, 'merge-batch', { ...common, ...landingPromptVars(run, task) })
      }
      // While a check is owed the merge command is never rendered: a prompt that shows it
      // while saying "don't" puts the wrong move one paste away.
      const owed = owedAt(run, task)
      return owed.length > 0
        ? renderPrompt(deps.pluginRoot, 'before-merge', { ...taskHoldVars(run, task, owed), ...heldSharedNote(run, task, hpipe) })
        : renderPrompt(deps.pluginRoot, 'merge', {
          ...common, ...mergePromptVars(run, task, hpipe), before_merge: taskRulingsNote(run, task),
        })
    }
    case 'sync':
      return renderPrompt(deps.pluginRoot, 'sync', { ...common, ...syncPromptVars(run, task, hpipe) })
    case 'implement': {
      // Re-entry from a red CI needs the failing checks inlined, and one from a check
      // the human failed needs what they saw; every other entry gets the standing
      // brief, which points a returning worker at the review file that sent it back.
      if (cameFrom === 'ci') {
        return renderPrompt(deps.pluginRoot, 'ci-red', { ...common, ci_failure: await deps.ciDetail(task.pr) })
      }
      const failure = cameFrom === 'merge' ? lastFailure(task) : null
      return failure === null
        ? renderPrompt(deps.pluginRoot, 'implement', common)
        : renderPrompt(deps.pluginRoot, 'check-failed', { ...common, ...checkFailedVars(failure) })
    }
    case 'escalated': {
      const from = task.escalated_from ?? cameFrom
      return renderPrompt(deps.pluginRoot, 'escalate', {
        run_id: run.run_id,
        phase: from,
        pass: String(counterFor(task, from)),
        resume_command: resumeCommand(hpipeCommand(deps.pluginRoot), run, task),
        abandon: abandonParagraph(hpipeCommand(deps.pluginRoot), run, task),
      })
    }
    default:
      return ''
  }
}

function taskArtifactPath(run: Run, task: Task, slot: 'research' | 'spec' | 'plan'): string {
  const rel = task.artifacts[slot]
  if (rel === null) return ''
  return join(artifactBase(run, task), rel)
}

export interface TaskPrompt {
  text: string
  paneId: string | null
  taskId: string
}

/**
 * The pane of the actor that owns the task's current row: both where that row's
 * prompt is delivered and the pane whose idleness gates it. Rows with no actor
 * of their own fall back to the orchestrator's.
 */
function actorPane(run: Run, task: Task): string | null {
  return taskRow(task.phase).actor === 'worker' ? task.pane_id : run.orchestrator_pane
}

const batchRefOf = (batch: Batch): string => `refs/remotes/origin/${batch.branch}`

async function changesOnly(
  repoRoot: string, from: string, to: string, git: LandingGit, only: (path: string) => boolean,
): Promise<boolean> {
  if (from === to) return true
  const paths = await git.changedPaths(repoRoot, from, to)
  return paths !== null && paths.every(only)
}

/** A push of review verdicts alone changes nothing a check tests, so it needs no new one. */
const addsOnlyReviews = (repoRoot: string, from: string, to: string, git: LandingGit): Promise<boolean> =>
  changesOnly(repoRoot, from, to, git, (path) => path.startsWith(`${REVIEWS_DIR}/`))

/**
 * Read by `submit`'s own rule: a move it would refuse as "nothing to land" is no
 * move, or the task sent to `sync` for it could never submit its way out.
 */
const addsNothingToLand = (repoRoot: string, from: string, to: string, git: LandingGit): Promise<boolean> =>
  changesOnly(repoRoot, from, to, git, landsNothing)

/**
 * Null skips the tick: a git read that fails must not read as "not landed",
 * which would send a landed task to sync.
 */
async function landingFacts(run: Run, task: Task, git: LandingGit): Promise<LandingFacts | null> {
  const landSha = task.land_sha
  if (run.batch === undefined || !landSha) return null
  const batchRef = batchRefOf(run.batch)
  const batchHead = await git.resolve(run.repo_root, batchRef)
  if (batchHead === null) return null
  const landed = await git.isAncestor(run.repo_root, landSha, batchRef)
  const upToDate = await git.isAncestor(run.repo_root, batchRef, landSha)
  if (landed === null || upToDate === null) return null
  const remote = await git.remoteBranchHead(run.repo_root, task.branch)
  if (!remote.ok) return null
  const moved = remote.sha !== null && !(await addsNothingToLand(run.repo_root, landSha, remote.sha, git)) &&
    await git.isAncestor(run.repo_root, remote.sha, batchRef) !== true
  const submitted = task.submission?.head_sha
  const checked = submitted !== undefined && await addsOnlyReviews(run.repo_root, submitted, landSha, git)
  return { movedTo: moved ? remote.sha : null, landed, upToDate, checked, batchHead }
}

type LandingFor = (task: Task) => Promise<LandingFacts | null>

/** One read per task per tick, however many rows ask about it. */
function landingReader(run: Run, git: LandingGit): LandingFor {
  const read = new Map<string, Promise<LandingFacts | null>>()
  return (task) => {
    let facts = read.get(task.task_id)
    if (facts === undefined) {
      facts = landingFacts(run, task, git)
      read.set(task.task_id, facts)
    }
    return facts
  }
}

/**
 * The tasks waiting to land that could take the slot now: one with a pane, or one
 * that lands without a sync and so needs no worker. A paneless task that must
 * sync would hold every landing up until an agent is started for it.
 */
async function eligibleToLand(run: Run, landingFor: LandingFor, except: Task | null = null): Promise<Task[]> {
  const eligible: Task[] = []
  for (const waiting of landingQueue(run.tasks)) {
    if (waiting === except) continue
    if (waiting.pane_id !== null) {
      eligible.push(waiting)
      continue
    }
    const facts = await landingFor(waiting)
    if (facts !== null && landsWithoutSync(facts)) eligible.push(waiting)
  }
  return eligible
}

async function takesTheSlot(run: Run, task: Task, landingFor: LandingFor): Promise<boolean> {
  if (landingSlotHolder(run.tasks) !== null) return false
  for (const waiting of landingQueue(run.tasks)) {
    if (waiting.pane_id === null) {
      const facts = await landingFor(waiting)
      if (facts === null || !landsWithoutSync(facts)) continue
    }
    return waiting === task
  }
  return false
}

/**
 * A row any agent can take, with no pane bound: the brief and the phase prompt
 * go out as one entry, as a rewind queues them, and wait in the outbox until an
 * agent is started in the worktree.
 */
async function queueForAFreshAgent(run: Run, task: Task, deps: TaskDeps): Promise<void> {
  if (queuedWorkerPrompt(run, task) !== null) return
  const phasePrompt = await renderTaskPhasePrompt(run, task, deps, task.phase)
  const brief = await renderWorkerPrompt(deps.pluginRoot, run, task)
  enqueue(run, { to: 'worker', taskId: task.task_id, ...briefAndPrompt(brief, phasePrompt) }, Date.now())
}

/**
 * Drives every task in a run one step. Each returned prompt names the pane it is
 * addressed to, because worker-owned rows send one tick's prompts to several
 * different agents; the dispatch prompt is the exception, addressed to the
 * ORCHESTRATOR because a queued task has no pane yet.
 */
export async function advanceTasks(run: Run, deps: TaskDeps): Promise<TaskPrompt[]> {
  const prompts: TaskPrompt[] = []

  // Tears down whatever was ALREADY sitting at `teardown` when this tick
  // started, before the loop below can advance anything else into that
  // phase. Every other phase transition in this driver gets one full tick to
  // sit before its next signal is evaluated (see the `continue` after a
  // queued task is dispatched); calling this after the loop instead would
  // let a task that reaches `teardown` THIS tick fall straight through to
  // `done` in the same call, skipping that phase's own settle.
  await runTeardown([run], deps, deps.effects)
  const landingFor = landingReader(run, deps.landingGit ?? LOCAL_LANDING_GIT)

  for (const task of run.tasks) {
    if (task.phase === 'queued') {
      const gate = gateStatus(task, run.tasks)
      if (gate.state === 'blocked-on-failure') {
        enterTaskPhase(run, task, 'blocked-on-failure', `depends on ${gate.on.join(', ')}`)
        continue
      }
      if (gate.state !== 'ready') continue

      enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'gate opened')
      const dispatchBase = await deps.freshDispatchBase(
        run.repo_root, dependencyMerges(task, run.tasks), run.batch?.branch ?? null,
      )
      const bootstrap = repoBootstrap(run.repo_root)
      prompts.push({
        text: `Dispatch ${task.task_id} (${task.branch}, ${task.bead}):\n` +
          `${bootstrapLine(bootstrap)}\n` +
          `${baseLine(dispatchBase)}\n` +
          `${dispatchSequence(run, task, dispatchBase, bootstrap, hpipeCommand(deps.pluginRoot))}\n\n` +
          (await renderWorkerPrompt(deps.pluginRoot, run, task)),
        paneId: run.orchestrator_pane,
        taskId: task.task_id,
      })
      continue
    }

    const row = taskRow(task.phase)
    const pane = actorPane(run, task)
    if (row.actor !== undefined && pane === null) {
      if (row.anyWorker !== true) continue
      // Still evaluated: a holder with no agent must yield the slot, and one whose
      // head has landed already must record it.
      await queueForAFreshAgent(run, task, deps)
    }
    const actorIdle = pane === null || (row.actor === 'worker' && owedItsPrompt(run, task)) ? false
      : await deps.liveIdle(pane)

    // Phases whose signal comes from the orchestrator must not be evaluated
    // while it is mid-turn, exactly as run phases are gated. Their signals are
    // GitHub's, so with no orchestrator there is no turn to wait out: a PR merged
    // by hand while it was `/exit`ed sat in `merge` for 10½ minutes until it came
    // back. Measured on a live run.
    if (row.actor === 'orchestrator' && !actorIdle && pane !== null && deps.hasLiveAgent(pane)) continue

    const worker = row.actor === 'worker' ? pane : null
    const busy = actorIdle && await runsInBackground(deps, worker)
    await noteUncommittedWork(run, task, actorIdle && !busy, deps)
    const gate = subagentGate(run, task, producedByActor(row) ? worker : null, deps)
    const signals = await gatherSignals(run, task, deps, actorIdle, landingFor, { busy, gate })
    if (!signals) continue

    const cameFrom = task.phase
    if (!advanceTask(run, task, signals)) continue
    if (task.phase === cameFrom) continue
    notePastSubagents(run, `${task.task_id} ${cameFrom}`, gate.past())

    if (taskRow(task.phase).anyWorker === true && task.pane_id === null) {
      await queueForAFreshAgent(run, task, deps)
      continue
    }
    const prompt = await promptForTaskPhase(run, task, deps, cameFrom)
    if (prompt.length > 0) {
      prompts.push({ text: prompt, paneId: actorPane(run, task), taskId: task.task_id })
    }
  }

  return prompts
}

/**
 * Claude Code runs a reviewer subagent only in the background, so its verdict lands
 * while the worker sits idle waiting for the completion notice, and the subagent can
 * leave the panel a moment before that notice starts a turn. Taken in that moment, the
 * next prompt would overtake the commit, the push and a CLEAR's fixes, and a BLOCKER's
 * send-back would record a head the verdict's own push then moves. The worker commits
 * the verdict only once it has handled the notice. Found by tracing a tick, not measured.
 *
 * git lists an untracked directory collapsed, `docs/`, when the verdict is the first
 * file in it. An unreadable checkout holds nothing, as it reports nothing.
 */
async function verdictUncommitted(run: Run, task: Task, deps: TaskDeps): Promise<boolean> {
  const verdict = artifactPathFor(run, task)
  if (task.checkout_path === null || verdict === null) return false
  const uncommitted = (await deps.uncommittedPaths(task.checkout_path)) ?? []
  return uncommitted.some((path) => path === verdict || (path.endsWith('/') && verdict.startsWith(path)))
}

async function runsInBackground(deps: Pick<TaskDeps, 'backgroundWork'>, pane: string | null): Promise<boolean> {
  return pane !== null && ((await deps.backgroundWork?.(pane)) ?? []).length > 0
}

/** Asked by the row once its own signal is ready, so a hold is never paid on a phase with nothing to take. */
interface SubagentGate {
  held: () => Promise<boolean>
  /** What the row advanced past at the cap, for its history. */
  past: () => readonly string[] | null
}

function subagentGate(run: Run, task: Task, pane: string | null, deps: TaskDeps): SubagentGate {
  let past: readonly string[] | null = null
  return {
    held: async () => {
      if (pane === null || deps.holdForSubagents === undefined) return false
      const call = await deps.holdForSubagents(holdKey(run, task), pane)
      if (!call.hold) past = call.past ?? null
      return call.hold
    },
    past: () => past,
  }
}


/**
 * #37. Intake declares `--files` before any research exists, so the honest list
 * is only knowable once a plan is written. Read here, at the gate, rather than
 * when `plan` clears: a CLEAR plan-review fixes MAJORs inline and may add files
 * to the plan after that. Widening only ever happens while a task holds no
 * files, so no task waits on a lock while holding one — which is what keeps two
 * mutual discoverers from deadlocking. Only the task being released needs to be
 * widened first: overlap is symmetric, so its widened set meets any sibling's
 * files whether or not that sibling has been widened yet.
 */
async function widenFromPlan(run: Run, task: Task): Promise<void> {
  const planPath = taskArtifactPath(run, task, 'plan')
  if (planPath === '' || !existsSync(planPath)) return
  const roots = [task.checkout_path, run.repo_root].filter((r): r is string => r !== null)
  const declared = planDeclaredFiles(await Bun.file(planPath).text(), roots)
  const { kept, ignored } = separatePipelineArtifacts(declared, task)
  const added = widenFiles(task.files, kept)
  if (added.length === 0) return
  task.files = [...task.files, ...added]
  const ignoredNote = ignored.length === 0 ? '' : ` (ignored pipeline artifacts: ${ignored.join(', ')})`
  const shared = sharedPrefixesOf(run)
  const described = (path: string): string =>
    path === '' ? '(whole repo)' : isSharedPath(path, shared) ? `${path} (shared, not locking)` : path
  console.error(
    `[pipeline] ${task.task_id} (${task.branch}): plan widened files by ` +
    added.map(described).join(', ') + ignoredNote,
  )
}

// Reported once per phase entry rather than once per 1s tick for the 45 minutes
// before the first stall probe. `run_id` is in the key because task ids are
// per-run: two live runs both hold a `t1`.
function logAmbiguous(run: Run, task: Task, candidates: string[], seen: Set<string>): void {
  const key = `${run.run_id}:${task.task_id}:${task.phase}:${task.phase_entered_at}`
  if (seen.has(key)) return
  seen.add(key)
  console.error(
    `[pipeline] ${task.task_id} (${task.branch}): ${task.phase} artifact missing and ` +
    `${candidates.length} candidates are ambiguous — ${candidates.join(', ')}`,
  )
}

async function gatherSignals(
  run: Run, task: Task, deps: TaskDeps, actorIdle: boolean, landingFor: LandingFor,
  pane: { busy: boolean; gate: SubagentGate },
) {
  const base = {
    actorIdle,
    artifactFresh: false,
    verdict: null as VerdictResult | null,
    prNumber: task.pr,
    headSha: null as string | null,
    merged: false,
    mergedAtMs: undefined as number | undefined,
    mergeCommit: undefined as string | undefined,
    filesClear: false,
    ciBucket: task.ci,
    maxPasses: deps.maxPasses,
  }

  const git = deps.landingGit ?? LOCAL_LANDING_GIT
  const singlePr = modeOf(run) === 'single-pr'

  switch (task.phase) {
    case 'implement': {
      if (singlePr) {
        if (!implementReady(run, task, base)) return base
        return (await pane.gate.held()) ? { ...base, actorIdle: false } : withSinglePrSkip(base, run, task, deps)
      }
      // GitHub's PR head lags a push, so a send-back can record the head from
      // before the reviewer's verdict commit, and that commit then reads as the
      // worker's push. Until the prompt lands the worker has pushed nothing, so
      // no head read can mean work. Found by tracing a tick, not measured.
      if (task.awaiting_brief === true || queuedWorkerPrompt(run, task) !== null) return base
      const pr = task.pr ?? (await deps.prForBranch(task.branch))
      if (pr === null) return base
      // Persist on discovery, not on the phase transition: otherwise every tick
      // re-queries gh for a PR we already know about.
      task.pr = pr
      const view = await deps.prView(pr)
      const signals = { ...base, prNumber: pr, headSha: view?.headSha ?? null }
      if (!implementReady(run, task, signals)) return signals
      if (await pane.gate.held()) return { ...signals, actorIdle: false }
      return { ...signals, ...await perTaskSkip(run, task, view?.baseRef ?? null, signals.headSha, deps) }
    }
    case 'research':
    case 'spec':
    case 'plan': {
      delete task.artifact_missing
      if (!actorIdle) return base
      const absolute = absoluteArtifactPath(run, task)
      if (absolute === null) return base

      if (await isFresh(absolute, artifactFreshAfter(task))) {
        if (!(await isSettled(absolute, deps.fileSettleMs))) return base
        if (await pane.gate.held()) return base
        return { ...base, artifactFresh: true }
      }

      // Stale is not missing. Every `onBlocker` re-entry re-stamps phase_entered_at
      // and leaves the previous artifact in place, so adopting on `!isFresh` would
      // replace an already-correct path with whatever else the worker committed
      // while revising. Only an ABSENT artifact is a candidate for adoption.
      if (existsSync(absolute)) return base

      const slot = taskRow(task.phase).artifact
      const checkout = task.checkout_path
      if (slot === undefined || checkout === null) return base

      // A worker not yet handed its brief (idle between `agent start` and
      // `dispatch --task`), or whose prompt for this phase has not reached it —
      // held by stuck input, a dead pane, or the next delivery — has written
      // nothing in answer to it. Both were reported as stopped short, and a stray
      // doc on the branch would be adopted as its artifact. Measured on a live run.
      if (task.awaiting_brief === true || queuedWorkerPrompt(run, task) !== null) return base

      const claimed = new Set(
        [task.artifacts.research, task.artifacts.spec, task.artifacts.plan]
          .filter((path): path is string => path !== null),
      )
      const candidates = await adoptableArtifacts(checkout, claimed, run.batch?.branch ?? null)
      const adopted = candidates.length === 1 ? candidates[0] : undefined
      if (adopted === undefined) {
        if (candidates.length > 1) {
          logAmbiguous(run, task, candidates, deps.ambiguityLog)
        }
        task.artifact_missing = { at: task.phase_entered_at, path: absolute, candidates }
        return base
      }
      if (!(await isSettled(join(checkout, adopted), deps.fileSettleMs))) return base

      // Recorded, not merely accepted: every later prompt cites the artifact by the
      // path stored here, and writing it back is what makes adoption idempotent —
      // the next tick's canonical stat hits the adopted path directly.
      task.artifacts[slot] = adopted
      if (await pane.gate.held()) return base
      return { ...base, artifactFresh: true }
    }
    case 'spec-review':
    case 'plan-review':
    case 'pr-review':
    case 'pr-review-intent':
    case 'pr-review-quality': {
      const verdict = await deps.verdictFor(run, task)
      const signals = { ...base, artifactFresh: verdict !== null, verdict }
      if (!actorIdle || verdict === null) return signals
      if (await verdictUncommitted(run, task, deps)) return { ...signals, actorIdle: false }
      if (await pane.gate.held()) return { ...signals, actorIdle: false }
      if (verdict.verdict !== 'CLEAR') return withSendBackHead(signals, run, task, deps)
      return singlePr && nextPhase(routeOf(run, task), taskRow(task.phase)) === 'land-queue'
        ? withReviewedHead(signals, run, task, git)
        : signals
    }
    case 'land-queue': {
      if (!singlePr || !(await takesTheSlot(run, task, landingFor))) return base
      const landing = await landingFor(task)
      return landing === null ? null : { ...base, slotMine: true, landing }
    }
    case 'sync': {
      if (!task.land_sha || run.batch === undefined) return base
      const landed = await git.isAncestor(run.repo_root, task.land_sha, batchRefOf(run.batch))
      if (landed === null) return null
      const landing = landed ? await landingFor(task) : undefined
      if (landing === null) return null
      const yieldAfterMs = deps.syncYieldMs ?? DEFAULT_SYNC_YIELD_MS
      const atWork = task.pane_id !== null && (!actorIdle || pane.busy)
      const held = actorIdle && syncSubmitted(task) !== null && await pane.gate.held()
      return {
        ...base, actorIdle: actorIdle && !held, landing, yieldAfterMs,
        yieldTo: atWork ? [] : await yieldCandidates(run, task, yieldAfterMs, landingFor),
      }
    }
    case 'merge': {
      if (singlePr) {
        const landing = await landingFor(task)
        return landing === null ? null : { ...base, landing }
      }
      if (task.pr === null) return base
      const view = await deps.prView(task.pr)
      if (!view?.merged) return { ...base, headSha: view?.headSha ?? null }
      return {
        ...base, merged: true, mergedAtMs: view.mergedAtMs ?? undefined,
        mergeCommit: view.mergeCommit ?? undefined,
      }
    }
    case 'close':
      return base
    // Recomputed here rather than snapshotted before the loop: a row that holds
    // no files can enter one that does mid-tick (a design row escalating, say),
    // and a snapshot taken before that would release an overlapping sibling onto
    // files now in flight.
    case 'blocked-on-files': {
      await widenFromPlan(run, task)
      const filesClear = releasableFromFiles(run).some((t) => t.task_id === task.task_id)
      if (!filesClear) task.files_waited_at = task.phase_entered_at
      return { ...base, filesClear }
    }
    case 'ci':
      return task.ci === 'fail' ? withSendBackHead(base, run, task, deps) : base
    default:
      return null
  }
}

/**
 * `implement` clears only on a head past `head_sha_at_entry`, which the machine
 * records from the signals of the row it is leaving. Only `implement` used to read
 * the head, so a send-back recorded null, any head counted as moved, and a worker
 * that went idle without pushing sent the unfixed PR back to review. Found by
 * tracing a tick, not measured. A failed read skips the tick: recording null
 * would disarm the guard just the same. CI can fail on a head the PR has
 * already moved past; recording the newer head costs a stall if the worker
 * does not push past it, never a false advance. The last allowed pass escalates rather
 * than return to `implement`, so it must not wait on gh.
 */
async function withSendBackHead<S extends { headSha: string | null; prNumber: number | null }>(
  signals: S, run: Run, task: Task, deps: TaskDeps,
): Promise<S | null> {
  const row = taskRow(task.phase)
  if (row.onBlocker !== 'implement') return signals
  if (row.counter !== undefined && counterFor(task, row.counter) + 1 >= deps.maxPasses) return signals
  if (modeOf(run) === 'single-pr') {
    const remote = await (deps.landingGit ?? LOCAL_LANDING_GIT).remoteBranchHead(run.repo_root, task.branch)
    return remote.ok && remote.sha !== null ? { ...signals, headSha: remote.sha } : null
  }
  const pr = task.pr ?? (await deps.prForBranch(task.branch))
  if (pr === null) return null
  task.pr = pr
  const view = await deps.prView(pr)
  if (view?.headSha == null) return null
  return { ...signals, prNumber: pr, headSha: view.headSha }
}

/**
 * The last review's CLEAR records what lands: the branch head, read in the same
 * tick the reviewers pushed their verdicts onto. It must contain the submitted
 * head; the machine sends a branch that lost it back to implement. A failed read
 * skips the tick, as a failed PR-head read does.
 */
async function withReviewedHead<S extends { headSha: string | null }>(
  signals: S, run: Run, task: Task, git: LandingGit,
): Promise<(S & { headContainsSubmission: boolean | null }) | null> {
  const remote = await git.remoteBranchHead(run.repo_root, task.branch)
  if (!remote.ok || remote.sha === null) return null
  const submitted = task.submission?.head_sha
  if (submitted === undefined) return { ...signals, headSha: remote.sha, headContainsSubmission: true }
  let contains = await git.isAncestor(run.repo_root, submitted, remote.sha)
  // A verdict pushed from another clone is not in this object store until fetched.
  if (contains === null && await git.fetch(run.repo_root, trackingRefspec(task.branch)) === null) {
    contains = await git.isAncestor(run.repo_root, submitted, remote.sha)
  }
  if (contains === null) return null
  return { ...signals, headSha: remote.sha, headContainsSubmission: contains }
}

/**
 * Sized against its base as just fetched, with the always-review list read there
 * rather than on the branch, so a change cannot take itself off the list. Any read
 * that fails means the review runs.
 */
async function sizedCall(
  run: Run, candidate: SkipCandidate, baseRef: string, head: string, deps: TaskDeps,
): Promise<ReviewCall> {
  const changes = deps.changeGit ?? LOCAL_CHANGE_GIT
  const counted = await changes.numstat(run.repo_root, baseRef, head)
  const listed = await changes.fileAt(run.repo_root, baseRef, ALWAYS_REVIEW_REL)
  const alwaysReview = !listed.ok ? null : listed.text === null ? [] : alwaysReviewPrefixes(listed.text)
  return reviewCall(candidate, counted === null ? null : changeSize(counted), alwaysReview, Date.now())
}

/** What the machine's `implement` exit reads: the skip, or why the review runs. */
interface SkipSignals { reviewSkip?: ReviewSkip; reviewedBecause?: string }

const UNMEASURED: SkipSignals = { reviewedBecause: 'its change could not be measured' }

function reviewedBecause(why: string | null): SkipSignals {
  return why === null ? {} : { reviewedBecause: why }
}

async function fetchedAll(run: Run, branches: string[], git: LandingGit): Promise<boolean> {
  for (const branch of branches) {
    if (await git.fetch(run.repo_root, trackingRefspec(branch)) !== null) return false
  }
  return true
}

/** The ledger's rules first, so a heavy or sent-back task costs no fetch. */
async function perTaskSkip(
  run: Run, task: Task, baseRef: string | null, head: string | null, deps: TaskDeps,
): Promise<SkipSignals> {
  const found = skipCandidacy(run, task)
  if (!('candidate' in found)) return reviewedBecause(found.reviewedBecause)
  if (baseRef === null || head === null) return UNMEASURED
  if (!(await fetchedAll(run, [baseRef, task.branch], deps.landingGit ?? LOCAL_LANDING_GIT))) return UNMEASURED
  const call = await sizedCall(run, found.candidate, `refs/remotes/origin/${baseRef}`, head, deps)
  return 'skip' in call ? { reviewSkip: call.skip } : reviewedBecause(call.reviewedBecause)
}

/**
 * The head that would land is read, and must contain the submission, before it is
 * sized: the skip judges exactly what `land-queue` then records.
 */
async function withSinglePrSkip<S extends { headSha: string | null }>(
  signals: S, run: Run, task: Task, deps: TaskDeps,
): Promise<(S & SkipSignals) | (S & { reviewSkip: ReviewSkip; headContainsSubmission: true })> {
  const found = skipCandidacy(run, task)
  if (!('candidate' in found)) return { ...signals, ...reviewedBecause(found.reviewedBecause) }
  const submitted = task.submission?.head_sha
  if (submitted === undefined || run.batch === undefined) return signals
  const git = deps.landingGit ?? LOCAL_LANDING_GIT
  const remote = await git.remoteBranchHead(run.repo_root, task.branch)
  if (!remote.ok || remote.sha === null) return { ...signals, ...UNMEASURED }
  if (!(await fetchedAll(run, [run.batch.branch, task.branch], git))) return { ...signals, ...UNMEASURED }
  if (await git.isAncestor(run.repo_root, submitted, remote.sha) !== true) return { ...signals, ...UNMEASURED }
  const call = await sizedCall(run, found.candidate, batchRefOf(run.batch), remote.sha, deps)
  if (!('skip' in call)) return { ...signals, reviewedBecause: call.reviewedBecause }
  return { ...signals, reviewSkip: call.skip, headSha: remote.sha, headContainsSubmission: true }
}

/**
 * Only once the holder is past its window with nothing submitted, and never while its
 * worker is at work: a conflict resolution and a long check can outlast the window, and
 * a yield then turns away the submit the check was for. A worker that never finishes
 * has its own stall ladder, which escalates it and passes the slot on.
 */
async function yieldCandidates(
  run: Run, task: Task, yieldAfterMs: number, landingFor: LandingFor,
): Promise<string[]> {
  if (!syncOverdue(task, yieldAfterMs, Date.now())) return []
  return (await eligibleToLand(run, landingFor, task)).map((t) => t.task_id)
}

/** The review verdict at the task's reserved path, if one newer than its baseline has settled. */
export async function freshVerdict(run: Run, task: Task, settleMs: number): Promise<VerdictResult | null> {
  const absolute = absoluteArtifactPath(run, task)
  if (!absolute) return null
  if (!(await isFresh(absolute, artifactFreshAfter(task)))) return null
  if (!(await isSettled(absolute, settleMs))) return null
  return parseVerdict(absolute)
}

export interface AnswerDeps {
  pluginRoot: string
  promptRetryMax: number
  /** `held` means nothing was sent — the delivery gate is pausing that pane. */
  send: (paneId: string, text: string) => Promise<{ ok: boolean; code?: string; held?: string }>
  /** Reads the worker's box on a later tick to see a sent answer submitted. */
  checkSubmission: CheckSubmission
  /** Collects what this tick did outside the ledger; see `saveOrReapply`. */
  effects?: RunEffect[]
}

function awaitingAnswer(run: Run, taskId: string, decisionId: string): Task | null {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (task?.phase !== 'blocked-on-decision' || task.pending_answer !== decisionId) return null
  return task
}

export function markAnswerSent(run: Run, taskId: string, decisionId: string, at: number): void {
  const task = awaitingAnswer(run, taskId, decisionId)
  if (task) task.answer_sent_at = at
}

export function markAnswerStalled(run: Run, taskId: string, decisionId: string, sentAt: number): void {
  const task = awaitingAnswer(run, taskId, decisionId)
  if (task?.answer_sent_at !== sentAt) return
  task.delivery_attempts += 1
  delete task.answer_sent_at
}

export function markAnswerDelivered(
  run: Run, taskId: string, decisionId: string, resumeTo: TaskPhase, seenWorking: boolean,
): void {
  const task = awaitingAnswer(run, taskId, decisionId)
  if (!task) return
  task.pending_answer = null
  task.delivery_attempts = 0
  // No prompt is rendered here, deliberately: `answer.md` has already been sent,
  // and rendering the row's own prompt would reserve a second verdict path and
  // move the file the agent was told to write. A resume is not a new review.
  enterTaskPhase(run, task, resumeTo, `decision ${decisionId} answered`)
  task.decision_from = null
  if (seenWorking) task.worked_on_answer = true
}

export function markDecisionAnnounced(
  run: Run, taskId: string, decisionId: string, at: number,
): void {
  const decision = run.tasks.find((t) => t.task_id === taskId)
    ?.decisions.find((d) => d.id === decisionId)
  if (decision && decision.prompted_at === null) decision.prompted_at = at
}

/**
 * The phase reset is a consequence of a successful send, never of the write.
 * A worker busy for more than PROMPT_RETRY_MAX ticks would otherwise have its
 * phase reset, its delivery abandoned, and would then complete the phase with
 * the answer unread — with run.history asserting the decision was applied.
 *
 * Successful means seen submitted on a later tick, not merely taken up: a resumed
 * phase may clear on a verdict written before the decision, so the answer must be
 * in, not in the box. Checked across ticks rather than waited on, so one answer
 * Claude is slow to submit cannot hold every other send of the tick.
 */
export async function deliverPendingAnswers(run: Run, deps: AnswerDeps): Promise<void> {
  for (const task of run.tasks) {
    if (task.phase !== 'blocked-on-decision' || task.pending_answer === null) continue
    if (task.pane_id === null) continue
    if (task.delivery_attempts >= deps.promptRetryMax) continue

    const resumeTo = task.decision_from
    if (resumeTo === null) continue

    const decision = task.decisions.find((d) => d.id === task.pending_answer)
    if (!decision) continue

    const text = await renderPrompt(deps.pluginRoot, 'answer', {
      question: decision.question,
      answer: decision.answer ?? '',
      answered_by: decision.answered_by ?? 'orchestrator',
      phase: resumeTo,
      before_merge: answerCheckNote(run, task, decision.id),
    })

    const taskId = task.task_id
    const decisionId = decision.id

    if (task.answer_sent_at !== undefined) {
      const sentAt = task.answer_sent_at
      const check = await deps.checkSubmission(task.pane_id, text, sentAt)
      if (check.state === 'stalled') {
        markAnswerStalled(run, taskId, decisionId, sentAt)
        deps.effects?.push((fresh) => markAnswerStalled(fresh, taskId, decisionId, sentAt))
      }
      if (check.state !== 'submitted') continue
      const seenWorking = check.working === true
      markAnswerDelivered(run, taskId, decisionId, resumeTo, seenWorking)
      deps.effects?.push((fresh) => markAnswerDelivered(fresh, taskId, decisionId, resumeTo, seenWorking))
      const hold = await holdOnResume(run, task, deps.pluginRoot)
      if (hold !== null) {
        queueHold(run, taskId, hold)
        deps.effects?.push((fresh) => queueHold(fresh, taskId, hold))
      }
      continue
    }

    // Stamped before the send: herdr's `working` event can be stamped before the
    // confirmed send returns, and `noteWorkingAfterAnswer` compares against this.
    const at = Date.now()
    const result = await deps.send(task.pane_id, text)
    if (!result.ok) {
      // A held send never reached herdr, so it must not spend the attempts that
      // decide when this answer is abandoned.
      if (result.held === undefined) task.delivery_attempts += 1
      continue
    }

    markAnswerSent(run, taskId, decisionId, at)
    deps.effects?.push((fresh) => markAnswerSent(fresh, taskId, decisionId, at))
  }
}

/**
 * A resume renders no prompt of its own, since `answer.md` has gone out, so a merge
 * that came to owe a check during the decision would leave the orchestrator holding
 * the merge command it was given on the earlier entry. The hold replaces it.
 */
async function holdOnResume(run: Run, task: Task, pluginRoot: string): Promise<string | null> {
  if (task.phase !== 'merge' || owedAt(run, task).length === 0) return null
  return renderTaskPhasePrompt(run, task, { pluginRoot, ciDetail: async () => '' }, 'merge')
}

function queueHold(run: Run, taskId: string, text: string): void {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (task?.phase !== 'merge') return
  const queued = (run.outbox ?? []).some((entry) =>
    entry.to === 'orchestrator' && entry.task_id === taskId && entry.entered_at === task.phase_entered_at)
  if (!queued) enqueue(run, { to: 'orchestrator', taskId, text }, Date.now())
}

/**
 * Stamping `prompted_at` only on a successful send mirrors deliverPendingAnswers:
 * a failed send must leave the decision eligible, or the orchestrator never
 * learns a question is waiting and the worker blocks forever.
 */
export async function announceDecisions(run: Run, deps: AnswerDeps): Promise<void> {
  if (run.orchestrator_pane === null) return
  for (const task of run.tasks) {
    if (task.phase !== 'blocked-on-decision') continue
    const decision = openDecisionFor(task)
    if (!decision || decision.prompted_at !== null) continue

    const text = await renderPrompt(deps.pluginRoot, 'decision', {
      ...tierPromptVars(run, task),
      decision_id: decision.id,
      phase: task.decision_from ?? '', question: decision.question,
      recommendation: decision.recommendation,
      branch: task.branch, ...beadPromptVars(task),
    })

    const result = await deps.send(run.orchestrator_pane, text)
    if (!result.ok) continue
    const taskId = task.task_id
    const decisionId = decision.id
    const at = Date.now()
    markDecisionAnnounced(run, taskId, decisionId, at)
    deps.effects?.push((fresh) => markDecisionAnnounced(fresh, taskId, decisionId, at))
  }
}
