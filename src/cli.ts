#!/usr/bin/env bun
import { copyFileSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  Bd, BD_ACTOR, CLI_LOCK_WAIT_MS, isBdFailure, type BdFailure, type BeadCreateInput, type BeadDetail, type CreatedBead, type Done,
} from './lib/bd'
import { claimForDispatch } from './lib/bead-claim'
import { DISCOVERED_LABEL, discoveryLabel } from './lib/bead-desired'
import { formatBeadDetail } from './lib/bead-view'
import { beadsSlug, readBeadsProject } from './lib/beads-project'
import { type SetupInput, type SetupResult, setupBeads, setupLines } from './lib/beads-setup'
import { checkoutSteps, checksDir, defaultBatchBranch, mergeBatchCommand, sha8 } from './lib/batch'
import { bootstrapLine, repoBootstrap } from './lib/bootstrap'
import { runChangeVars } from './lib/change-prompt'
import { CHECK_REL, checkFailure, type CheckRun, checkLine, repoCheck, runCheck } from './lib/check'
import { bvTriage } from './lib/bv'
import { observePanes, type PaneHold, readPaneHolds } from './lib/delivery-health'
import { abandonDecisions, answerDecision, openDecision, openDecisionFor } from './lib/decisions'
import {
  baseLine, branchNameRefusal, dependencyMerges, type DispatchBase, fetchDefaultBranch, fetchFromOrigin,
  freshDispatchBase, pushToOrigin, remoteBranchHead, trackingRefspec,
} from './lib/dispatch-base'
import { Gh } from './lib/gh'
import { detectCycle, gateStatus } from './lib/gating'
import { type BeadClaimant, beadClaimants, beadHolds, heldBy, holdsBead, phaseHoldsBead } from './lib/held'
import { Herdr, type CallResult } from './lib/herdr'
import {
  BATCH_SCHEMA_VERSION, isUnlandedSave, listRuns, newRun, resolveCurrentSchemaRun, retryOnStaleRun, runById, runForRepo,
  runForWorkspace, runIsDriven, runPhaseState, saveRun, taskPhaseIsTerminal, unlandedSaveMessage,
  wasAborted, withBatch, writeOrchestrator,
} from './lib/ledger'
import type { RunQuery, RunReach, RunResolution } from './lib/ledger'
import { enterRunPhase, enterTaskPhase, forgetDecisionRoundTrip } from './lib/machine'
import { REVIEW_EFFORT } from './lib/models'
import { formatNext, type TriageOutput } from './lib/next'
import { enqueue, queuedResume, queuedWorkerPrompt } from './lib/outbox'
import {
  isTier, modeName, modeOf, type PhaseRow, rowRunsIn, RUN_ROWS, type RunMode, TASK_ROWS, TIERS, runRow, taskRow, tierOf,
} from './lib/phases'
import { drivenSchemas, type SupervisorState, supervisorState } from './lib/pidfile'
import { drain, enqueue as enqueueEvent } from './lib/queue'
import { hpipeCommand, renderPrompt } from './lib/render'
import { repoContext } from './lib/repo'
import { sessionKey } from './lib/session'
import { formatStatus, formatTaskDetail, resumeCommand } from './lib/status'
import { effortSummary } from './lib/tier-prompt'
import { isLowering, pipelinePanes, registrationTier } from './lib/tiers'
import { bdProblem, bvProblem, checkBd, checkBv, checkTools, type Tools, toolsLine } from './lib/tools'
import {
  bindWorkerPane, briefCommand, dispatchSequence, dispatchWorkerCommand, freshLadder, shellQuoted, startWorkerCommand,
  unbriefedWorker,
} from './lib/unstarted'
import { ARTIFACT_ROOT, reserveVerdict } from './lib/verdict-path'
import { renderWorkerPrompt } from './lib/worker-prompt'
import { cleanupLines, renderRunPhasePrompt, uncommittedPaths } from './supervisor/deliver'
import { closeReason } from './supervisor/beads-sync'
import { renderTaskPhasePrompt } from './supervisor/tasks'
import { checkReleaseTitle, releaseSections } from './lib/release-title'
import { headOf, isAncestor, nothingToLand, resolveCommit, syncWalk, type SyncWalk } from './lib/sync-walk'
import type { Batch, BeadBrief, CheckOutcome, Run, RunPhase, Submission, Task, TaskPhase } from './lib/types'
import { isAgentReady } from './lib/machine'
import { type LimitReading, readLimit, resetText } from './supervisor/usage-limits'

export interface Ctx { stateDir: string; pluginRoot: string; session: string }
export interface CmdResult { ok: boolean; text: string; json?: string }

const ok = (text: string, json?: string): CmdResult => ({ ok: true, text, json })
const fail = (text: string): CmdResult => ({ ok: false, text })

/**
 * A command that loses a save to the supervisor re-runs from its first read, so
 * every guard is re-checked against what the supervisor just wrote. One that
 * cannot land says so and exits non-zero: printing success for a recovery
 * command the supervisor then discarded is how #51 stayed invisible.
 */
function retryingOnStale<A extends unknown[]>(
  command: (...args: A) => Promise<CmdResult>,
): (...args: A) => Promise<CmdResult> {
  return async (...args) => {
    try {
      return await retryOnStaleRun(() => command(...args))
    } catch (error) {
      if (isUnlandedSave(error)) return fail(unlandedSaveMessage(error))
      throw error
    }
  }
}

// No leading article: the call sites supply their own, so both "found no run in
// intake, dispatch or execute" and "more than one live run" read as sentences.
function phraseFor(phases: readonly RunPhase[] | null): string {
  if (phases === null || phases.length === 0) return 'live run'
  const names = [...phases]
  const last = names.pop() as RunPhase
  return names.length === 0 ? `run in ${last}` : `run in ${names.join(', ')} or ${last}`
}

const runLine = (run: Run): string => `  ${run.run_id} (${run.phase})`

// The phase on each line is the reason it was excluded, so a run that is merely
// past this command's phases is not described as finished — and an unreadable
// one says so, because `(dnoe)` alone reads like an ordinary phase name.
function excludedLine(run: Run, hpipe: string): string {
  const state = runPhaseState(run)
  if (state === 'unreadable') return `  ${run.run_id} (${run.phase}) — unrecognised phase, in no phase row`
  if (state === 'live' && !runIsDriven(run)) {
    return `${runLine(run)} — parked; \`${resumeCommand(hpipe, run)}\` resumes it`
  }
  return runLine(run)
}

/**
 * The sentence a failed resolution prints. #36's brief was wrong for hours
 * because nothing said a second `t1` existed — so a no-match names the runs it
 * excluded, and only offers a way into a finished one when the command has one.
 */
function resolveFailure(
  ctx: Ctx, query: RunQuery, escape: string | null,
  result: Exclude<RunResolution, { ok: true }>,
): CmdResult {
  const scope = [
    phraseFor(query.phases),
    query.taskId === null ? null : `holding ${query.taskId}`,
    query.repoKey === null ? null : `for ${query.repoKey}`,
    `in session ${ctx.session}`,
  ].filter((s): s is string => s !== null).join(' ')
  const hpipe = hpipeCommand(ctx.pluginRoot)

  switch (result.reason) {
    case 'no-such-run':
      return fail(`no such run: ${query.runId}`)
    case 'unreadable':
      return fail(`${result.run.run_id} is in ${result.run.phase}, which is in no phase row — ` +
        `rewind it to a real phase: ${hpipe} rewind ${result.run.run_id} <phase>`)
    case 'terminal':
      return fail(`run ${result.run.run_id} is finished (phase: ${result.run.phase}) — ` +
        'a finished run cannot be re-entered')
    case 'parked':
      return fail(`run ${result.run.run_id} is parked in ${result.run.phase}; the supervisor ` +
        `drives nothing on it until a human rewinds it — \`${resumeCommand(hpipe, result.run)}\` resumes it`)
    case 'wrong-phase':
      return fail(`run ${result.run.run_id} is in ${result.run.phase}; ` +
        `this needs a ${phraseFor(query.phases)}`)
    case 'ambiguous':
      return fail(`more than one ${scope}:\n` +
        result.candidates.map(runLine).join('\n') +
        '\n  → name one with --run <run-id>')
    case 'none': {
      if (result.excluded.length === 0) return fail(`found no ${scope}`)
      // Only worth saying when one of them actually is finished: `excluded` also
      // holds live runs that are simply past this command's phases.
      const anyTerminal = result.excluded.some((r) => runPhaseState(r) === 'terminal')
      const tail = !anyTerminal ? ''
        : escape === null ? '\n  a finished run cannot be re-entered'
        : `\n  → ${escape}`
      return fail(`found no ${scope}\n  excluded:\n` +
        result.excluded.map((r) => excludedLine(r, hpipe)).join('\n') + tail)
    }
  }
}

type Resolved<T> = { ok: true; value: T } | { ok: false; result: CmdResult }

/**
 * Resolve a run for one command, or the sentence to print instead. Every
 * command goes through here so `--run` is validated and a failure is worded the
 * same way whoever asked; `escape` is how this command reaches a finished run,
 * or null when it has no way in. Runs of an older schema are not candidates: they
 * are no longer advanced, and a leftover one would make every task id ambiguous.
 */
async function resolveFor(ctx: Ctx, query: RunQuery, escape: string | null): Promise<Resolved<Run>> {
  if (query.runId !== null && query.runId.trim().length === 0) {
    return { ok: false, result: fail('--run needs a run id') }
  }
  const resolved = await resolveCurrentSchemaRun(ctx.stateDir, ctx.session, query)
  return resolved.ok
    ? { ok: true, value: resolved.run }
    : { ok: false, result: resolveFailure(ctx, query, escape, resolved) }
}

/**
 * The four commands addressed by task id share this: a task id is per-run
 * (`t${n}`), so the run has to be pinned before the id means anything.
 */
async function resolveTask(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null
  reach: RunReach; escape: string | null
}): Promise<Resolved<{ run: Run; task: Task }>> {
  if (input.taskId.trim().length === 0) {
    return { ok: false, result: fail('--task is required') }
  }

  const query: RunQuery = {
    runId: input.runId, repoKey: input.repoKey,
    phases: null, taskId: input.taskId, reach: input.reach,
  }
  const found = await resolveFor(ctx, query, input.escape)
  if (!found.ok) return found

  const task = found.value.tasks.find((t) => t.task_id === input.taskId)
  if (!task) return { ok: false, result: fail(`no such task: ${input.taskId}`) }
  return { ok: true, value: { run: found.value, task } }
}

export interface StartBeads {
  tools: () => Promise<Tools>
  setup: (input: SetupInput) => Promise<SetupResult>
}

const REAL_START_BEADS: StartBeads = { tools: checkTools, setup: (input) => setupBeads(input) }

/** What `start --single-pr` asks outside git: whether the supervisor can drive a batch, and whether GitHub can squash. */
export interface StartBatch {
  supervisor: () => Promise<SupervisorState>
  squashMergeAllowed: (repoRoot: string) => Promise<{ allowed: boolean } | { error: string }>
}

const realStartBatch = (ctx: Ctx): StartBatch => ({
  supervisor: () => supervisorState(ctx.stateDir, ctx.session),
  squashMergeAllowed: (repoRoot) => new Gh(process.env.GH_BIN ?? 'gh', repoRoot).squashMergeAllowed(),
})

interface BatchPlan { branch: string; into: string; commit: string; adopted: boolean }

/**
 * Every check `start --single-pr` makes before anything is written: each only
 * reads, so a refusal leaves no Beads store, no branch and no run behind.
 */
async function planBatch(
  ctx: Ctx, run: Run, requested: string | null, deps: StartBatch,
): Promise<{ ok: true; plan: BatchPlan } | { ok: false; error: string }> {
  const refuse = (error: string) => ({ ok: false as const, error: `${error}; nothing was started` })

  const supervisor = await deps.supervisor()
  if (supervisor.state === 'live' && !drivenSchemas(supervisor.info).includes(BATCH_SCHEMA_VERSION)) {
    return refuse(`the supervisor of session ${ctx.session} (pid ${supervisor.info.pid}) predates single-PR runs ` +
      'and would never advance this one: close its `Pipeline supervisor` pane and run the plugin\'s `supervisor` ' +
      'action, then start again')
  }

  const fetched = await fetchDefaultBranch(run.repo_root)
  if (fetched.fetchError !== null || fetched.commit === null) {
    return refuse(`could not fetch the default branch from origin (${fetched.fetchError ?? 'no commit resolved'}), ` +
      'and a stale base would put work already on it into the batch PR')
  }

  const branch = requested ?? defaultBatchBranch(run.run_id, run.repo_root)
  if (branch === fetched.branch) {
    return refuse(`${branch} is the default branch, which the batch ships into; name a branch of its own`)
  }
  const badName = await branchNameRefusal(run.repo_root, branch)
  if (badName !== null) return refuse(badName)

  const squash = await deps.squashMergeAllowed(run.repo_root)
  if ('error' in squash) return refuse(`could not ask GitHub whether this repo allows squash merges: ${squash.error}`)
  if (!squash.allowed) {
    return refuse('this repo does not allow squash merges, and the batch PR must be squash-merged for its ' +
      "release notes to apply: allow them in the repo's settings, or start without --single-pr")
  }

  const onOrigin = await remoteBranchHead(run.repo_root, branch)
  if (!onOrigin.ok) return refuse(`could not ask origin about ${branch}: ${onOrigin.reason}`)
  if (onOrigin.sha !== null && onOrigin.sha !== fetched.commit) {
    return refuse(`${branch} already exists on origin at ${sha8(onOrigin.sha)}, not at ${fetched.branch}'s ` +
      `${sha8(fetched.commit)}: name another with --batch-branch, or delete it if it is a leftover`)
  }
  return { ok: true, plan: { branch, into: fetched.branch, commit: fetched.commit, adopted: onOrigin.sha !== null } }
}

function batchLines(plan: BatchPlan, repoRoot: string): string[] {
  const adopted = plan.adopted ? '; already on origin at that commit, so it is adopted' : ''
  return [
    `batch: ${plan.branch} at ${sha8(plan.commit)} (origin/${plan.into} as just fetched${adopted}) — ` +
      `this run ships as one PR into ${plan.into}`,
    checkLine(repoCheck(repoRoot)),
    'ruleset: protect batch/* from force-pushes and deletion (GitHub → Settings → Rules → Rulesets): git ' +
      'refuses only a landing that is not a fast-forward, and a --force push gets through without one',
  ]
}

export async function cmdStart(ctx: Ctx, input: {
  title: string; repoKey: string; repoRoot: string
  socketPath: string; paneId: string; workspaceId: string
  prefix: string | null; singlePr: boolean; batchBranch: string | null
}, beads: StartBeads = REAL_START_BEADS, batch: StartBatch = realStartBatch(ctx)): Promise<CmdResult> {
  if (input.batchBranch !== null && !input.singlePr) {
    return fail('--batch-branch only goes with --single-pr: a per-task run has no batch branch')
  }
  const existing = await runForRepo(ctx.stateDir, ctx.session, input.repoKey)
  if (existing.kind !== 'free') {
    const blocker = existing.kind === 'ambiguous' ? existing.runs[0] as Run : existing.run
    return fail(`a run is already active for this repo: ${blocker.run_id} (phase ${blocker.phase}). ` +
      `Finish it, or run: ${hpipeCommand(ctx.pluginRoot)} abort ${blocker.run_id}`)
  }

  const run = newRun({
    session: ctx.session, socketPath: input.socketPath,
    repoKey: input.repoKey, repoRoot: input.repoRoot, title: input.title,
  })
  let plan: BatchPlan | null = null
  if (input.singlePr) {
    const planned = await planBatch(ctx, run, input.batchBranch, batch)
    if (!planned.ok) return fail(planned.error)
    plan = planned.plan
  }

  const tools = await beads.tools()
  const bdBroken = bdProblem(tools.bd)
  if (bdBroken !== null) return fail(`${bdBroken}\nhpipe start needs a working bd; nothing was started`)
  const setup = await beads.setup({
    stateDir: ctx.stateDir, repoKey: input.repoKey, repoRoot: input.repoRoot, prefix: input.prefix,
  })
  if (!setup.ok) return fail(setup.error)
  const bvBroken = bvProblem(tools.bv)

  // After the Beads setup, so a Beads failure leaves no branch behind.
  if (plan !== null && !plan.adopted) {
    const refused = await pushToOrigin(input.repoRoot, plan.commit, plan.branch)
    if (refused !== null) return fail(`could not push ${plan.branch} to origin: ${refused}; nothing was started`)
  }
  if (plan !== null) {
    withBatch(run, {
      branch: plan.branch, into: plan.into, base_commit: plan.commit,
      checkout: join(resolve(ctx.stateDir), 'checkouts', run.run_id),
      pr: null, head_sha_at_entry: null, ci: null, merged_at_ms: null, merge_commit: null,
    })
  }
  run.orchestrator_pane = input.paneId
  await saveRun(ctx.stateDir, run)
  await writeOrchestrator(ctx.stateDir, ctx.session, input.repoKey, {
    pane_id: input.paneId, workspace_id: input.workspaceId,
    socket_path: input.socketPath, claimed_at: Date.now(),
  })

  const intake = await renderPrompt(ctx.pluginRoot, 'intake', {
    ...runChangeVars(run, hpipeCommand(ctx.pluginRoot)),
    run_id: run.run_id, title: run.title,
  })
  const preface = [
    ...setupLines(setup, ctx.stateDir),
    ...(bvBroken === null ? [] : [`tools: ${bvBroken} — the board and \`hpipe next\` stay off until it is fixed`]),
    ...(plan === null ? [] : batchLines(plan, input.repoRoot)),
  ]
  return ok(`${preface.join('\n')}\n\n${intake}`, JSON.stringify({ run_id: run.run_id }))
}

const REGISTRABLE: readonly RunPhase[] = ['intake', 'dispatch', 'execute']
/**
 * A single-PR run is also registrable here: a red final CI too big to patch, or a
 * branch-review BLOCKER, becomes a fix task, and registering it moves the run back
 * to `execute`. A run rewind there would not do: intake stays closed, and the run
 * is back in `branch-review` on the next tick.
 */
const SHIPPING: readonly RunPhase[] = ['branch-review', 'ship', 'ship-ci', 'ship-merge']
const PHASES_BEFORE_A_PR: ReadonlySet<string> = new Set<TaskPhase>([
  'queued', 'research', 'spec', 'spec-review', 'plan', 'plan-review', 'blocked-on-files', 'implement',
])
const PHASES_BEFORE_A_MERGE: ReadonlySet<string> = new Set<string>([
  ...PHASES_BEFORE_A_PR, 'pr-review', 'pr-review-intent', 'pr-review-quality', 'ci', 'land-queue', 'sync', 'merge',
])
const LANDING_PHASES: ReadonlySet<string> = new Set<TaskPhase>(['land-queue', 'sync', 'merge'])

/** Whether the batch PR has merged: null when GitHub could not say. */
export type BatchShipped = (repoRoot: string, pr: number) => Promise<boolean | null>

const ghBatchShipped: BatchShipped = async (repoRoot, pr) => {
  const view = await new Gh(process.env.GH_BIN ?? 'gh', repoRoot).prView(pr)
  return view === null ? null : view.merged
}

/**
 * One GitHub question per command. A stale save re-runs the whole attempt, and a
 * gh call inside it outlasts a supervisor tick, so every attempt would lose to the
 * supervisor's next save; asked once, before the retried save, it costs none of them.
 */
function askedOnce(shipped: BatchShipped): BatchShipped {
  const answers = new Map<string, Promise<boolean | null>>()
  return (repoRoot, pr) => {
    const key = `${repoRoot}\0${pr}`
    let answer = answers.get(key)
    if (answer === undefined) {
      answer = shipped(repoRoot, pr)
      answers.set(key, answer)
    }
    return answer
  }
}

/** Why nothing more can join this single-PR run, or null. Once its PR merged, a fix lands on a branch already shipped. */
async function shippedRefusal(run: Run, shipped: BatchShipped): Promise<string | null> {
  const batch = run.batch
  if (batch === undefined) return null
  if (batch.merged_at_ms !== null) return `the batch already shipped as PR #${batch.pr ?? 'unknown'}`
  if (batch.pr === null) return null
  const merged = await shipped(run.repo_root, batch.pr)
  if (merged === null) return `could not ask GitHub whether PR #${batch.pr} has merged; run it again`
  return merged ? `the batch already shipped as PR #${batch.pr}` : null
}

/** The store for this repo, or why the CLI cannot use one. */
async function cliBd(stateDir: string, repoKey: string): Promise<Bd | BdFailure> {
  const slug = beadsSlug(repoKey)
  if ((await readBeadsProject(stateDir, slug)) === null) {
    return {
      reason: 'unavailable',
      error: `no Beads store for ${repoKey} — \`hpipe start\` there sets one up, or run the "Set up Beads for this repo" action`,
    }
  }
  const broken = bdProblem(await checkBd())
  if (broken !== null) return { reason: 'unavailable', error: broken }
  return new Bd({ stateDir, slug, lockWaitMs: CLI_LOCK_WAIT_MS })
}

async function withCliBd<T>(
  stateDir: string, repoKey: string, use: (bd: Bd) => Promise<T | BdFailure>,
): Promise<T | BdFailure> {
  const bd = await cliBd(stateDir, repoKey)
  return isBdFailure(bd) ? bd : use(bd)
}

export interface RegistrationBeads {
  create: (repoKey: string, input: BeadCreateInput) => Promise<CreatedBead | BdFailure>
  show: (repoKey: string, id: string) => Promise<BeadDetail | BdFailure>
}

const cliRegistrationBeads = (stateDir: string): RegistrationBeads => ({
  create: (repoKey, input) => withCliBd(stateDir, repoKey, (bd) => bd.create(input)),
  show: (repoKey, id) => withCliBd(stateDir, repoKey, (bd) => bd.show(id)),
})

/** What one `hpipe task` call carries across the stale-run retries of its registration. */
interface RegistrationAttempt {
  fileBeadOnce: (repoKey: string, input: BeadCreateInput) => Promise<CreatedBead | BdFailure>
  showBeadOnce: (repoKey: string, id: string) => Promise<BeadDetail | BdFailure>
  landed: (taskId: string) => void
  dispatchBase: DispatchBaseFor
  shipped: BatchShipped
}

type DispatchBaseFor = (
  repoRoot: string, dependencyMerges: string[] | null, branch: string | null,
) => Promise<DispatchBase>

interface TaskInput {
  branch: string; bead?: string; surface: string; notes: string
  dependsOn: string[]; files: string[]; keepWorktree: boolean
  repoKey: string | null; runId: string | null
  title?: string; bodyFile?: string; acceptanceFile?: string
  tier?: string
  callerPane?: string | null
}

/**
 * Why taking `tasks`' beads back would give a bead two holders, or null. A bead
 * released by an abort or a failure may have been adopted by another run, from
 * any session; the reconciler would then follow one of the two silently, and
 * the other would stall in `close` with advice that closes the wrong run's bead.
 */
async function beadsTakenMeanwhile(ctx: Ctx, run: Run, tasks: readonly Task[]): Promise<string | null> {
  const hpipe = hpipeCommand(ctx.pluginRoot)
  const holds = await beadHolds(ctx.stateDir)
  const conflicts: string[] = []
  for (const task of tasks) {
    const holder = holds.get(task.bead)
    if (holder === undefined) continue
    if (holder.session === run.session && holder.run_id === run.run_id && holder.task_id === task.task_id) continue
    conflicts.push(`bead ${task.bead} (${task.task_id}) is now held by ${holder.task_id} (${holder.phase}) ` +
      `in run ${holder.run_id}, session ${holder.session} — finish that run, or abort it from its own session ` +
      `with \`${hpipe} abort ${holder.run_id}\`, then retry`)
  }
  if (conflicts.length === 0) return null
  return `${conflicts.join('\n')}\nOr leave this one where it is and register its work as a new task on a ` +
    'different bead'
}

const isReadableFile = (path: string): boolean => existsSync(path) && statSync(path).isFile()

async function lastClaimant(stateDir: string, repoKey: string, bead: string): Promise<BeadClaimant | null> {
  const named = (await beadClaimants(stateDir)).filter((c) => c.repo_key === repoKey && c.bead === bead)
  return named.reduce<BeadClaimant | null>((latest, c) =>
    (latest === null || c.registered_at > latest.registered_at ? c : latest), null)
}

/**
 * Why an existing bead cannot become a task, or null. Each refusal keeps one of
 * bd's close guards from firing at merge: a foreign assignee, an open blocker,
 * or an open child.
 */
async function adoptionRefusal(stateDir: string, repoKey: string, bead: BeadDetail): Promise<string | null> {
  if (bead.status === 'closed') return `bead ${bead.id} is closed — adopt an open bead, or file a new one with --title`
  const holder = await heldBy(stateDir, bead.id)
  if (holder !== null) {
    return `bead ${bead.id} is already held by ${holder.task_id} (${holder.phase}) in run ${holder.run_id}, ` +
      `session ${holder.session}`
  }
  if (bead.assignee === BD_ACTOR) {
    const releasedBy = await lastClaimant(stateDir, repoKey, bead.id)
    if (releasedBy !== null) {
      return `bead ${bead.id} is still assigned to hpipe by ${releasedBy.task_id} of run ${releasedBy.run_id} ` +
        `(session ${releasedBy.session}), which no longer holds it. Only the supervisor of session ` +
        `${releasedBy.session} releases it, on its next tick once it is running; adopt it after that`
    }
  }
  if ((bead.assignee ?? '') !== '') {
    return `bead ${bead.id} is assigned to ${bead.assignee} — only an unassigned bead can be adopted`
  }
  const blockers = (bead.dependencies ?? []).filter((d) => d.dependency_type === 'blocks' && d.status !== 'closed')
  if (blockers.length > 0) {
    return `bead ${bead.id} is blocked by open ${blockers.map((d) => d.id).join(', ')} — finish or adopt those first`
  }
  // Only children: an open `blocks` or `discovered-from` dependent trips no close
  // guard, and those are the beads `hpipe next` ranks highest.
  const children = (bead.dependents ?? [])
    .filter((d) => d.dependency_type === 'parent-child' && d.status !== 'closed')
  if (children.length > 0) {
    return `bead ${bead.id} has open child beads (${children.map((d) => d.id).join(', ')}) — an epic or ` +
      'parent bead cannot be adopted; adopt its children instead'
  }
  return null
}

function filingInput(input: TaskInput): BeadCreateInput {
  return {
    title: input.title!,
    body: readFileSync(resolve(input.bodyFile!), 'utf8'),
    acceptance: input.acceptanceFile === undefined ? undefined : readFileSync(resolve(input.acceptanceFile), 'utf8'),
    labels: [],
  }
}

/** The single-PR run a fix task would reopen, if this repo's live run is shipping. */
async function shippingRun(ctx: Ctx, input: TaskInput): Promise<Run | null> {
  const shipping = await resolveCurrentSchemaRun(ctx.stateDir, ctx.session, {
    runId: input.runId, repoKey: input.repoKey, phases: SHIPPING, taskId: null, reach: 'unfinished',
  })
  return shipping.ok && modeOf(shipping.run) === 'single-pr' ? shipping.run : null
}

async function registerTask(
  ctx: Ctx, input: TaskInput, attempt: RegistrationAttempt,
): Promise<CmdResult> {
  const query: RunQuery = {
    runId: input.runId, repoKey: input.repoKey,
    phases: REGISTRABLE, taskId: null, reach: 'unfinished',
  }
  // A v2 run's tasks carry no bead, so it must neither take this task nor make
  // the resolution ambiguous.
  const found = await resolveFor(ctx, query, null)
  let run: Run
  let reopensShipping = false
  if (found.ok) {
    run = found.value
  } else {
    const shipping = await shippingRun(ctx, input)
    if (shipping === null) return found.result
    run = shipping
    reopensShipping = true
    const refusal = await shippedRefusal(run, attempt.shipped)
    if (refusal !== null) return fail(`${refusal}; register the fix in a new run`)
  }

  // Work with no bead behind it used to fall outside the pipeline and be
  // hand-rolled, which is where the mistakes were. Filing one here keeps the
  // brief captured at registration as the worker's one source. Measured on a live run.
  const filing = input.title !== undefined
  const adopting = input.bead !== undefined

  // The argv parser leaves a missing --branch as "". Without these checks a
  // mistyped command mints a ghost task into a live run, and there is no command
  // that removes one. Measured on a live run.
  if (filing && adopting) {
    return fail('--bead adopts an existing bead and --title files a new one — pass one, not both')
  }
  if (!filing && !adopting) {
    return fail('a task needs a bead: --bead <id> adopts an existing one, ' +
      '--title <title> --body-file <path> files a new one')
  }
  if (adopting && input.bead!.trim().length === 0) return fail('--bead needs a bead id')
  if (filing) {
    if (input.title!.trim().length === 0) return fail('--title cannot be empty')
    // --title is free text, so the argv layer lets a missing value swallow the
    // next flag — and the bead it files would carry that flag's name.
    if (input.title!.startsWith('--')) {
      return fail(`--title got a flag where the title belongs: "${input.title}" — the value after --title is missing`)
    }
    if (input.bodyFile === undefined) return fail('--title needs --body-file: the body is the worker\'s brief')
    const bodyPath = resolve(input.bodyFile)
    if (!isReadableFile(bodyPath)) return fail(`--body-file is not a file: ${bodyPath}`)
    if (input.acceptanceFile !== undefined && !isReadableFile(resolve(input.acceptanceFile))) {
      return fail(`--acceptance-file is not a file: ${resolve(input.acceptanceFile)}`)
    }
  } else if (input.bodyFile !== undefined || input.acceptanceFile !== undefined) {
    return fail('--body-file and --acceptance-file only go with --title; an existing bead already has its brief')
  }
  if (input.branch.trim().length === 0) return fail('--branch is required')
  if (input.branch.startsWith('-')) return fail(`--branch cannot start with "-", got: ${input.branch}`)
  if (run.batch !== undefined && [run.batch.branch, run.batch.into].includes(input.branch)) {
    const which = input.branch === run.batch.branch
      ? 'batch branch, which tasks land on'
      : 'default branch, which the batch ships into'
    return fail(`--branch ${input.branch} is this run's ${which}; give the task a branch of its own`)
  }

  const agentFile = join(run.repo_root, '.claude', 'agents', `${input.surface}-dev.md`)
  if (!existsSync(agentFile)) {
    return fail(`no agent definition at ${agentFile} — check --surface`)
  }

  // A path prefix cannot contain whitespace, and cannot look like a flag. Both are
  // argv accidents: one quoted space-separated list in a single --files, or a
  // --files with no value swallowing the next flag. Neither is detectable later —
  // filesOverlap simply never fires and the gate reports "no overlapping files in
  // flight" while two workers edit the same files. Measured on a live run.
  for (const entry of input.files) {
    if (/\s/.test(entry)) {
      return fail(
        `--files is comma-separated; this entry contains whitespace: "${entry}"\n` +
        `  → --files ${entry.trim().split(/\s+/).join(',')}`,
      )
    }
    if (entry.startsWith('--')) {
      return fail(
        `--files got a flag where a path prefix belongs: "${entry}" — ` +
        'the value after --files is missing',
      )
    }
  }

  const taskId = `t${run.tasks.length + 1}`

  // detectCycle skips ids it does not recognise, so a typo would otherwise pass
  // validation here and then wait in `queued` forever with no diagnostic. The
  // new task's own id counts as known — depending on yourself is a cycle, not
  // a typo, and must fall through to the cycle check below to be reported as one.
  const known = new Set([...run.tasks.map((t) => t.task_id), taskId])
  const unknown = input.dependsOn.filter((id) => !known.has(id))
  if (unknown.length > 0) return fail(`--depends-on names no such task: ${unknown.join(', ')}`)

  const cycle = detectCycle([...run.tasks, { task_id: taskId, depends_on: input.dependsOn }])
  if (cycle) return fail(`--depends-on forms a cycle: ${cycle.join(' → ')}`)

  // Before filing or reading, so a typo'd --tier files nothing and costs no bd round-trip.
  const flagRefused = input.tier !== undefined && !isTier(input.tier)
  let adopted: BeadDetail | null = null
  if (adopting && !flagRefused) {
    const id = input.bead!.trim()
    const shown = await attempt.showBeadOnce(run.repo_key, id)
    if (isBdFailure(shown)) return fail(`bd show ${id} failed; nothing was registered:\n  ${shown.error}`)
    const refusal = await adoptionRefusal(ctx.stateDir, run.repo_key, shown)
    if (refusal !== null) return fail(refusal)
    adopted = shown
  }
  const chosen = registrationTier(input.tier, adopted?.labels ?? null)
  if (!chosen.ok) return fail(chosen.error)

  // Last, after every check: a bead filed for a registration that then fails
  // sits in the backlog with nothing in the pipeline behind it.
  let bead: string
  let brief: BeadBrief
  let filed = false
  if (adopted !== null) {
    bead = adopted.id
    brief = {
      title: adopted.title, description: adopted.description ?? '', acceptance: adopted.acceptance_criteria ?? '',
      labels: adopted.labels ?? [], captured_at_ms: Date.now(),
    }
  } else {
    const createInput = filingInput(input)
    const created = await attempt.fileBeadOnce(run.repo_key, createInput)
    if (isBdFailure(created)) {
      return fail(`bd create failed; nothing was filed or registered:\n  ${created.error}`)
    }
    bead = created.id
    filed = true
    brief = {
      title: createInput.title, description: createInput.body, acceptance: createInput.acceptance ?? '',
      labels: createInput.labels, captured_at_ms: Date.now(),
    }
  }

  const date = new Date().toISOString().slice(0, 10)
  const stem = `${date}-${bead}`

  const task: Task = {
    task_id: taskId,
    branch: input.branch, bead, brief, surface: input.surface,
    depends_on: input.dependsOn, files: input.files,
    keep_worktree: input.keepWorktree,
    workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'queued', phase_entered_at: Date.now(),
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: null, registered_at: Date.now(), adopted_at: null,
    artifacts: {
      research: join(ARTIFACT_ROOT, 'research', `${stem}-research.md`),
      spec: join(ARTIFACT_ROOT, 'specs', `${stem}-design.md`),
      plan: join(ARTIFACT_ROOT, 'plans', `${stem}-plan.md`),
      verdicts: {},
    },
    merged_at_ms: null, merge_commit: null, bead_closed_at_ms: null,
    bead_sync: { failures: 0, streak: 0, last_error: null, last_ok_at_ms: null },
    discoveries: [], passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: input.notes,
    tier: chosen.tier,
    tier_history: [{
      at: Date.now(), from: null, to: chosen.tier, source: chosen.source,
      pane: input.callerPane ?? null, why: chosen.why,
    }],
  }

  run.tasks.push(task)
  // execute completes only once intake is closed and every task is terminal, so a
  // task registered mid-run must reopen the gate or the run could complete underneath it.
  run.intake_closed = false
  if (reopensShipping) enterRunPhase(run, 'execute', 'a fix task was registered')

  // The CLI is handing the prompt over now, so the task is dispatched. Leaving it
  // `queued` would make the next tick deliver the same prompt a second time. One
  // save for registration and dispatch together: a stale second save would make
  // the retry register the task twice.
  const gate = gateStatus(task, run.tasks)
  if (gate.state === 'ready') {
    enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'dispatched at registration')
  }
  await saveRun(ctx.stateDir, run)
  attempt.landed(task.task_id)

  // The recorded set, printed back. A malformed --files is otherwise invisible:
  // the only other place task.files reaches a human is the blocked-on-files
  // warning in status.ts, which speaks only once overlap has already fired — so a
  // declaration that matches nothing is silent by construction.
  const filesLine = `files: ${task.files.length > 0 ? task.files.join(', ') : 'none'}`

  // The same line the supervisor's dispatch prompt prints, on the path that
  // actually dispatches: 17 of the last 20 tasks left `queued` here, not in the
  // supervisor's tick. Measured on the live ledger.
  const bootstrap = repoBootstrap(run.repo_root)
  const bootLine = bootstrapLine(bootstrap)

  const header = [
    ...(reopensShipping
      ? [`run moved to execute: register any other fix, then \`${hpipeCommand(ctx.pluginRoot)} dispatch --done\``]
      : []),
    `task_id: ${task.task_id}`, `tier: ${chosen.tier} (${chosen.why})`, `effort: ${effortSummary(task)}`,
    ...(filed ? [`bead: ${bead} (filed)`] : []), filesLine, bootLine,
  ].join('\n')

  if (gate.state !== 'ready') return ok(`${header}\nqueued: waiting on ${gate.on.join(', ')}`)

  // After the save, not before: nothing here is recorded, and a fetch between
  // the read and the save only widens the window a concurrent write can take.
  const base = await attempt.dispatchBase(run.repo_root, dependencyMerges(task, run.tasks), run.batch?.branch ?? null)
  const prompt = await renderWorkerPrompt(ctx.pluginRoot, run, task)
  const sequence = dispatchSequence(run, task, base, bootstrap, hpipeCommand(ctx.pluginRoot))
  return ok(`${header}\n${baseLine(base)}\n${sequence}\n\n${prompt}`)
}

export async function cmdTask(
  ctx: Ctx, input: TaskInput, beads: RegistrationBeads = cliRegistrationBeads(ctx.stateDir),
  dispatchBase: DispatchBaseFor = freshDispatchBase, shipped: BatchShipped = ghBatchShipped,
): Promise<CmdResult> {
  // The retry re-runs registerTask from a fresh read, so the bd calls are memoised
  // out here: a second attempt reuses the bead the first one filed and the bead it
  // read, and never files another.
  const outcome: {
    filing: Promise<CreatedBead | BdFailure> | null
    shown: Promise<BeadDetail | BdFailure> | null
    registeredAs: string | null
  } = { filing: null, shown: null, registeredAs: null }
  const attempt: RegistrationAttempt = {
    fileBeadOnce: (repoKey, createInput) => (outcome.filing ??= beads.create(repoKey, createInput)),
    showBeadOnce: (repoKey, id) => (outcome.shown ??= beads.show(repoKey, id)),
    landed: (taskId) => { outcome.registeredAs = taskId },
    dispatchBase,
    shipped: askedOnce(shipped),
  }
  const shipping = await shippingRun(ctx, input)
  if (shipping !== null) await shippedRefusal(shipping, attempt.shipped)
  const filedBead = async (): Promise<CreatedBead | null> => {
    const filed = outcome.filing === null ? null : await outcome.filing
    return filed === null || isBdFailure(filed) ? null : filed
  }

  let reason: string
  try {
    const result = await retryOnStaleRun(() => registerTask(ctx, input, attempt))
    if (result.ok) return result
    reason = result.text
  } catch (error) {
    const filed = await filedBead()
    if (filed === null) {
      if (isUnlandedSave(error)) return fail(unlandedSaveMessage(error))
      throw error
    }
    // Not unlandedSaveMessage: its "run it again" would file a second bead.
    reason = error instanceof Error ? error.message : String(error)
  }

  const filed = await filedBead()
  if (filed === null) return fail(reason)
  if (outcome.registeredAs !== null) {
    return fail(
      `task ${outcome.registeredAs} is registered with bead ${filed.id}, but: ${reason}\n` +
      `  → ${hpipeCommand(ctx.pluginRoot)} brief --task ${outcome.registeredAs} prints its brief; do not register it again`,
    )
  }
  return fail(
    `${reason}\nbead ${filed.id} was filed but no task was registered\n` +
    `  → register it with --bead ${filed.id} in place of --title and --body-file; ` +
    're-running with --title files a second bead',
  )
}

/**
 * Read-only. Without it the only way to see a worker brief is to register a
 * task, which mutates the run — so an orchestrator that loses its context has
 * no way back to the text it is supposed to hand over. Measured on a live run.
 */
export async function cmdBrief(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'finished-if-named', escape: '--run <run-id> renders it anyway',
  })
  if (!found.ok) return found.result

  return ok(await renderWorkerPrompt(ctx.pluginRoot, found.value.run, found.value.task))
}

/**
 * Read-only, and reaches a finished run under --run, like `brief`. An unfinished
 * task also gets a freshly fetched `base:` line: it is what the recovery advice
 * cuts a lost worktree from, and the one its dispatch printed may be long gone
 * from the orchestrator's context and stale besides.
 */
export async function cmdShow(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null
}, dispatchBase: DispatchBaseFor = freshDispatchBase): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'finished-if-named', escape: '--run <run-id> shows it anyway',
  })
  if (!found.ok) return found.result
  const { run, task } = found.value
  const detail = formatTaskDetail(run, task)
  if (task.phase === 'done' || taskRow(task.phase).terminal === true) return ok(detail)
  const base = await dispatchBase(run.repo_root, dependencyMerges(task, run.tasks), run.batch?.branch ?? null)
  return ok(`${detail}\n${baseLine(base)}`)
}

export type ClaimBead = (repoKey: string, bead: string) => Promise<Done | BdFailure>

const cliClaimBead = (stateDir: string): ClaimBead => (repoKey, bead) =>
  withCliBd(stateDir, repoKey, (bd) => claimForDispatch(bd, bead))

export type SendBrief = (paneId: string, text: string) => Promise<CallResult<unknown>>

/**
 * The handoff `agent start "<brief>"` could not make: herdr refuses to encode a
 * brief's fences and backticks as a shell argument, which fails every task. The
 * brief goes over `agent prompt` instead, the same channel the supervisor uses
 * for every later phase. Measured on a live run.
 */
export type ReadPaneLimit = (paneId: string) => Promise<LimitReading | null>

const cliReadPaneLimit: ReadPaneLimit = (paneId) => readLimit(new Herdr(), paneId)

export async function cmdDispatchTask(ctx: Ctx, input: {
  taskId: string; paneId: string; repoKey: string | null; runId: string | null
}, send: SendBrief, recordPane: typeof recordWorkerPane = recordWorkerPane,
  claim: ClaimBead = cliClaimBead(ctx.stateDir), readPaneLimit: ReadPaneLimit = cliReadPaneLimit,
): Promise<CmdResult> {
  // Not `driven`, unlike decide: this command delivers the brief itself, and the
  // worker's artifacts are stat'ed on the first tick after the rewind. Refusing
  // would strand the opposite way, since registration already moved the task past
  // `queued` and nothing else ever re-sends a brief to its fresh pane.
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (input.paneId.trim().length === 0) {
    return fail('--pane is required: the root pane `worktree create` returned')
  }

  // A queued task's files or dependencies are still held; starting its worker
  // now is exactly the parallel edit `--files` and `--depends-on` exist to stop.
  if (task.phase === 'queued') {
    const gate = gateStatus(task, run.tasks)
    const waitingOn = gate.state === 'ready' ? '' : `: waiting on ${gate.on.join(', ')}`
    return fail(`task ${task.task_id} is still queued${waitingOn} — you will be told when it is ready`)
  }
  if (taskPhaseIsTerminal(task.phase)) {
    return fail(`task ${task.task_id} is finished (phase: ${task.phase}) — there is no worker to brief`)
  }
  // Past the gate's first phase a worker already holds the brief. Re-sending it
  // would restart that worker's instructions mid-phase, and `--until working`
  // matches at once on a busy agent, so the confirmation would prove nothing.
  const briefedPhase = taskRow('queued').onClear as TaskPhase
  if (task.phase !== briefedPhase) {
    return fail(`task ${task.task_id} is already in ${task.phase}, past ${briefedPhase} — ` +
      `its worker has the brief; \`${hpipeCommand(ctx.pluginRoot)} brief --task ${task.task_id}\` prints it to reread`)
  }

  // Checked before the send, because a brief sent to the wrong pane cannot be
  // recalled, and a pane recorded on the wrong task routes that pane's events —
  // exit, release, idle — to whichever of the two `findTask` meets first.
  if (input.paneId === run.orchestrator_pane) {
    return fail(`${input.paneId} is this run's orchestrator pane — pass the worker's root pane`)
  }
  const holder = run.tasks.find((t) => t.task_id !== task.task_id && t.pane_id === input.paneId)
  if (holder) {
    return fail(`${input.paneId} is already ${holder.task_id}'s worker pane — pass ${task.task_id}'s ` +
      'root pane, from `herdr pane list --workspace <its workspace>`')
  }

  // A brief typed into a pane Claude's usage limit has stopped is rejected on
  // arrival, yet herdr confirms it, and the task would wait on a worker that never
  // read it.
  const limit = await readPaneLimit(input.paneId)
  if (limit?.line != null && isAgentReady(limit.status)) {
    const reset = resetText(limit.line)
    return fail(`the agent in ${input.paneId} is stopped by Claude's usage limit` +
      `${reset === null ? '' : ` (resets ${reset})`}; nothing was sent — run this again after the reset`)
  }

  // Before the send: a brief cannot be recalled, and a bead someone else holds
  // must refuse the dispatch rather than surface later as a reconciler failure.
  // Until `recordPane` clears `awaiting_brief` the desired bead is still open and
  // unassigned, so a reconciler pass in between un-assigns this claim once and the
  // next pass re-assigns it: harmless, and not worth a ledger write before the send.
  const claimed = await claim(run.repo_key, task.bead)
  if (isBdFailure(claimed)) {
    return fail(`bd would not let ${task.task_id} claim ${task.bead}; nothing was sent:\n  ${claimed.error}`)
  }

  const brief = await renderWorkerPrompt(ctx.pluginRoot, run, task)
  const sent = await send(input.paneId, brief)
  if (!sent.ok) {
    const reason = `brief for ${task.task_id} not confirmed in ${input.paneId}: ` +
      `${sent.code ?? 'error'}${sent.message ? ` — ${sent.message}` : ''}`
    // Only these two come back after herdr accepted the text; every other code
    // is a rejection before anything reached the pane.
    const mayHaveLanded = sent.code === 'agent_prompt_stalled' || sent.code === 'timeout'
    return fail(mayHaveLanded
      ? `${reason}\n  → herdr pane read ${input.paneId} before retrying: the brief was ` +
        'submitted and may already be in the pane, and a retry would send it twice; if it ' +
        `sits unsubmitted in the input box, \`herdr agent send-keys ${input.paneId} ctrl+c\` ` +
        'empties it while the worker is idle'
      : `${reason}\n  → nothing was sent; fix the cause and run it again`)
  }

  const delivered = `brief for ${task.task_id} delivered to ${input.paneId}; the worker has picked it up`
  const unrecorded = await recordPane(ctx, {
    runId: run.run_id, taskId: task.task_id, paneId: input.paneId, briefedPhase,
  })
  if (unrecorded === null) return ok(delivered)
  // Still `ok`, and never "run it again": the brief has landed, and a re-run is
  // let through by the briefed-phase guard and would hand the worker a second one.
  return ok(`${delivered}\n  ⚠ but its pane was not recorded (${unrecorded}). Do not run ` +
    '`dispatch --task` again — that would brief the worker twice. The pane binds on its own ' +
    'once herdr reports the agent.')
}

/**
 * Written only after herdr confirmed the handoff, and re-read rather than reusing
 * the copy the send began with: the supervisor saves the run many times during
 * a confirmation wait. Recording the pane here, as well as on
 * `pane.agent_detected`, is what keeps a lost hook event from leaving a briefed
 * worker looking as though no agent was ever started for it — and recording the
 * handoff is what stops an idle, freshly started worker reading as one that
 * stopped short (#89). Returns why the pane was not recorded, or null.
 */
export async function recordWorkerPane(ctx: Ctx, input: {
  runId: string; taskId: string; paneId: string; briefedPhase: TaskPhase
}, save: (stateDir: string, run: Run) => Promise<void> = saveRun): Promise<string | null> {
  try {
    return await retryOnStaleRun(async () => {
      const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
      const task = run?.tasks.find((t) => t.task_id === input.taskId)
      if (!run || !task) return `${input.taskId} is gone from the ledger`
      // A pane that exited during the confirmation wait has already failed the
      // task and been unbound; binding it again would make a rewind read as bound.
      if (task.phase !== input.briefedPhase) return null
      const wasAwaitingBrief = task.awaiting_brief === true
      delete task.awaiting_brief
      const rebound = bindWorkerPane(run, task, input.paneId, Date.now())
      if (rebound || wasAwaitingBrief) await save(ctx.stateDir, run)
      return null
    })
  } catch (error) {
    if (isUnlandedSave(error)) return 'the ledger kept changing under the save'
    throw error
  }
}

async function closeIntake(ctx: Ctx, input: {
  runId: string | null; repoKey: string | null
}): Promise<CmdResult> {
  const query: RunQuery = {
    runId: input.runId, repoKey: input.repoKey,
    phases: REGISTRABLE, taskId: null, reach: 'unfinished',
  }
  const found = await resolveFor(ctx, query, null)
  if (!found.ok) return found.result

  const run = found.value
  run.intake_closed = true
  await saveRun(ctx.stateDir, run)
  return ok(`intake closed for ${run.run_id}`)
}
export const cmdDispatchDone = retryingOnStale(closeIntake)

/**
 * The supervisor prompts only for the phase entries it makes, so a rewound worker
 * sat idle until the stall probe, 45 minutes by default. Measured on a live run.
 * Queued in the rewind's own save: a rewind that loses to the supervisor re-runs
 * from its read and queues against the entry that finally lands. Rendered against
 * the path the rewind already reserved, never through `promptForTaskPhase`, which
 * would reserve a second one and move the file the rewind just printed.
 *
 * Returns what the operator is told about it, or '' when nothing is owed.
 */
async function owePhasePrompt(ctx: Ctx, run: Run, task: Task | null): Promise<string> {
  const row = task ? taskRow(task.phase) : runRow(run.phase)
  if (row.actor !== 'worker' && row.actor !== 'orchestrator') return ''
  const worker = task !== null && row.actor === 'worker'
  const hpipe = hpipeCommand(ctx.pluginRoot)
  const setUpWorker = (t: Task): string => (t.workspace_id === null
    ? dispatchWorkerCommand(run, t, hpipe)
    : startWorkerCommand(run, t, t.workspace_id, hpipe))
  const briefedPhase = taskRow('queued').onClear
  if (worker && task.pane_id === null && task.phase === briefedPhase) {
    return `; no worker is bound, so nothing is sent — ${setUpWorker(task)}`
  }

  // `cameFrom` is the phase itself: the standing prompt, not a CI failure the rewind never read.
  const phasePrompt = task
    ? await renderTaskPhasePrompt(run, task, { pluginRoot: ctx.pluginRoot, ciDetail: async () => '' }, task.phase)
    : await renderRunPhasePrompt(run, ctx.pluginRoot, { stateDir: ctx.stateDir })
  if (phasePrompt.length === 0) return ''
  // No pane means the next agent is a fresh one, and every phase prompt assumes the
  // brief — task id, agent file, `decide`, never main — already arrived. One entry,
  // so the courier hands it both in order the moment the agent is detected.
  const text = worker && task.pane_id === null
    ? `${await renderWorkerPrompt(ctx.pluginRoot, run, task)}\n\n---\n\n${phasePrompt}`
    : phasePrompt
  enqueue(run, { to: row.actor, taskId: task?.task_id ?? null, text }, Date.now())
  if (!worker) return '; its prompt is queued for the orchestrator'
  return task.pane_id === null
    ? `; its prompt is queued for ${task.task_id}'s worker, which is not bound yet — ${setUpWorker(task)}`
    : `; its prompt is queued for ${task.pane_id}`
}

function modePhases(rows: readonly PhaseRow<string>[], mode: RunMode): string {
  return `its phases are ${rows.filter((r) => rowRunsIn(r, mode)).map((r) => r.phase).join(', ')}`
}

interface RewindInput { runId: string; phase: string; taskId: string | null }

/**
 * The run would otherwise review, ship, or reach `done` and stop being driven, with
 * the rewound task stranded behind it. The run phases registration reopens.
 */
function rewindReopensShipping(run: Run, input: RewindInput): boolean {
  return Boolean(input.taskId) && modeOf(run) === 'single-pr' && SHIPPING.includes(run.phase) &&
    TASK_ROWS.some((r) => r.phase === input.phase) && !taskPhaseIsTerminal(input.phase)
}

async function rewind(ctx: Ctx, input: RewindInput, shipped: BatchShipped): Promise<CmdResult> {
  const run = await runById(ctx.stateDir, ctx.session, input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  // The phase is written onto the record unvalidated today, and every later row
  // lookup throws on one that is in no row — including the terminal test below.
  // `isTask` is shared with the branch below, which tests truthiness: flag() can
  // return '', and validating against TASK_ROWS then writing to run.phase is
  // exactly the mismatch this check exists to close.
  const isTask = Boolean(input.taskId)
  const rows = isTask ? TASK_ROWS : RUN_ROWS
  if (!rows.some((r) => r.phase === input.phase)) {
    return fail(`no such phase: ${input.phase || '(missing)'} — valid ` +
      `${isTask ? 'task' : 'run'} phases are ${rows.map((r) => r.phase).join(', ')}`)
  }
  // Tiers only warn about this, because a task routed past a row still leaves it.
  // A mode cannot: a single-PR task left in `ci` waits forever on a PR that does
  // not exist, and a per-task one in `land-queue` on a batch branch it never had.
  const mode = modeOf(run)
  const target = (rows as readonly PhaseRow<string>[]).find((r) => r.phase === input.phase)!
  if (!rowRunsIn(target, mode)) {
    return fail(`${input.phase} is not a phase of a ${modeName(mode)} run — ${modePhases(rows, mode)}`)
  }

  // A rewind ONTO a review row commissions a new review but renders no prompt —
  // `advanceTask` returns null for a row whose verdict is not fresh, so the task
  // loop never reaches `promptForTaskPhase`. Without reserving here the next review
  // is handed the previous one's filename, which is this issue.
  let reserved: string | null = null
  let rewoundTask: Task | null = null
  let tierWarning = ''
  let reopensShipping = ''

  if (isTask) {
    const task = run.tasks.find((t) => t.task_id === input.taskId)
    if (!task) return fail(`no such task: ${input.taskId}`)
    rewoundTask = task

    // A landing reads the reviewed head, never the branch, so a task cannot land
    // again without one: the last landing's is the head that is already on the batch.
    if (modeOf(run) === 'single-pr' && LANDING_PHASES.has(input.phase) && !task.land_sha) {
      const last = task.landed?.at(-1)
      if (last === undefined) {
        return fail(`no reviewed head is recorded for ${task.task_id}: rewind it to a review row`)
      }
      task.land_sha = last.land_sha
    }
    if (rewindReopensShipping(run, input)) {
      const refusal = await shippedRefusal(run, shipped)
      if (refusal !== null) return fail(`${input.taskId} was not rewound: ${refusal}`)
      enterRunPhase(run, 'execute', `${input.taskId} was rewound to ${input.phase}`)
      reopensShipping = '; the run moves back to execute'
    }

    if (!phaseHoldsBead(run.phase, task.phase) && phaseHoldsBead(run.phase, input.phase)) {
      const taken = await beadsTakenMeanwhile(ctx, run, [task])
      if (taken !== null) return fail(`${input.taskId} was not rewound:\n${taken}`)
    }

    if (task.pending_answer !== null) {
      run.history.push({
        at: Date.now(), task_id: task.task_id, from: task.phase, to: input.phase,
        why: `answer to ${task.pending_answer} discarded, undelivered`,
      })
      task.pending_answer = null
    }

    // A terminal rewind ends every question addressed to this task; otherwise
    // openDecisionFor keeps hpipe status reporting a decision the task can never
    // return to. `escalated` is deliberately excluded — it carries returnsTo, so
    // it can come back still needing its answer. After the block above, so an
    // answered-but-undelivered decision keeps its own history entry rather than
    // being abandoned silently.
    if (taskPhaseIsTerminal(input.phase)) {
      const open = openDecisionFor(task)
      abandonDecisions(task)
      if (open) {
        run.history.push({
          at: Date.now(), task_id: task.task_id, from: task.phase, to: input.phase,
          why: `decision ${open.id} abandoned, unanswered`,
        })
      }
    }

    task.phase = input.phase as TaskPhase
    const rowTiers = taskRow(task.phase).tiers
    const taskTier = tierOf(task)
    if (rowTiers !== undefined && !rowTiers.includes(taskTier)) {
      tierWarning = `\nwarning: ${task.phase} is not in tier ${taskTier}; the task will leave it by the ${taskTier} route`
    }
    task.passes = {}
    task.delivery_attempts = 0
    task.phase_entered_at = Date.now()
    // Rewinding into the decision is how an escalation out of one resumes; the
    // asked-from phase's entry still stands for the answer that is coming.
    const keptBaseline = input.phase === 'blocked-on-decision' ? task.artifact_fresh_after : undefined
    forgetDecisionRoundTrip(task)
    if (keptBaseline !== undefined) task.artifact_fresh_after = keptBaseline
    task.escalated_from = null
    // Written here because a rewind bypasses `enterTaskPhase`. A paneless rewind
    // into the briefed phase is handed to a fresh agent through `dispatch --task`,
    // so it owes a brief; a bound worker already has one.
    if (task.phase === taskRow('queued').onClear && task.pane_id === null) task.awaiting_brief = true
    else delete task.awaiting_brief
    // `implement` persists the first PR it finds and never asks again, and `merge`
    // is a level: a task sent back to rework after its PR merged would otherwise
    // carry the old PR through `merge` on its old mergedAt, with the new work
    // never merged. `prForBranch` lists open PRs only, so it finds the new one.
    // `head_sha_at_entry` is kept: a resume with the PR still open must wait for
    // a push past the head the last review rejected, and a PR opened after a merge
    // carries commits past it anyway.
    if (PHASES_BEFORE_A_PR.has(task.phase)) {
      task.pr = null
      task.ci = null
      delete task.land_sha
    }
    // A standing merge keeps the bead closed through the rework, and a standing
    // close would clear `close` the instant `merge` records the merge again.
    if (PHASES_BEFORE_A_MERGE.has(task.phase)) {
      task.merged_at_ms = null
      task.merge_commit = null
      task.bead_closed_at_ms = null
    }
    // The same stale bucket `enterTaskPhase` forgets on entry: kept, it fails the
    // rewound round on the next tick, before the poller has read the PR again.
    if (task.phase === 'ci') task.ci = null
    run.history.push({ at: Date.now(), task_id: task.task_id, from: 'rewind', to: input.phase, why: 'manual rewind' })
    if (taskRow(task.phase).signal === 'verdict') {
      reserved = reserveVerdict(run, task, task.phase)
    }
  } else {
    run.phase = input.phase as RunPhase
    run.passes = {}
    run.phase_entered_at = Date.now()
    run.escalated_from = null
    // `ship` finds the PR again if it is still open; `prForBranch` lists open ones only.
    if (run.batch !== undefined && run.phase === 'ship') run.batch.pr = null
    if (run.batch !== undefined && run.phase === 'ship-ci') run.batch.ci = null
    run.history.push({ at: Date.now(), from: 'rewind', to: input.phase, why: 'manual rewind' })
    if (runRow(run.phase).signal === 'verdict') {
      reserved = reserveVerdict(run, null, run.phase)
    }
  }

  const owed = await owePhasePrompt(ctx, run, rewoundTask)
  await saveRun(ctx.stateDir, run)
  return ok(
    `rewound ${input.taskId ?? input.runId} to ${input.phase}; counters cleared` +
    (reserved === null ? '' : `; next verdict → ${reserved}`) + reopensShipping + owed + tierWarning,
  )
}
export async function cmdRewind(
  ctx: Ctx, input: RewindInput, shipped: BatchShipped = ghBatchShipped,
): Promise<CmdResult> {
  const askShipped = askedOnce(shipped)
  const before = await runById(ctx.stateDir, ctx.session, input.runId)
  if (before && rewindReopensShipping(before, input)) await shippedRefusal(before, askShipped)
  return retryingOnStale(rewind)(ctx, input, askShipped)
}

export interface SubmitDeps {
  /** An open PR from `branch`, by number, or why gh could not say. */
  openPr: (repoRoot: string, branch: string) => Promise<{ pr: number | null } | { error: string }>
  runCheck?: (checkout: string, logPath: string) => Promise<CheckRun>
}

const REAL_SUBMIT_DEPS: SubmitDeps = {
  openPr: (repoRoot, branch) => new Gh(process.env.GH_BIN ?? 'gh', repoRoot).openPrForBranch(branch),
}

interface SubmitInput { taskId: string; title: string | null; repoKey: string | null; runId: string | null }

/** The title a sync keeps when it names none: the change's own, from its last submission or landing. */
function standingTitle(task: Task): string | null {
  return task.submission?.title ?? task.landed?.at(-1)?.title ?? null
}

function submittedLine(task: Task, sub: Submission, batch: Batch): string {
  const checked = sub.check === 'passed' ? 'check passed' : `no ${CHECK_REL} declared`
  const head = `submitted ${task.task_id} at ${sha8(sub.head_sha)} as "${sub.title}" (${sub.kind}; ${checked})`
  if (sub.kind !== 'sync') return head
  return sub.merge === 'clean'
    ? `${head} — a clean merge of ${batch.branch}: it lands next`
    : `${head} — not a clean merge of ${batch.branch} (at ${sha8(sub.dirty_at ?? sub.head_sha)}): it goes back ` +
      'through review before it lands'
}

/** Everything `submit` verified, kept for the one quick save that records it. */
interface PreparedSubmission {
  runId: string
  taskId: string
  kind: Submission['kind']
  enteredAt: number
  landSha: string | null
  submission: Submission
  note: string | null
}

type Prepared<T> = { ok: true; value: T } | { ok: false; result: CmdResult }

/**
 * Everything slow happens here, once, before the ledger is touched: one fetch, one
 * ls-remote, one PR lookup and the check. Inside a save's stale-retry they could
 * never land, because a live supervisor saves the run every tick and the network
 * calls alone outlast one: berean-os's smoke worker failed nine submits in a row.
 * Measured on a live run.
 */
async function prepareSubmission(
  ctx: Ctx, input: SubmitInput, deps: SubmitDeps,
): Promise<Prepared<{ prepared: PreparedSubmission; batch: Batch }>> {
  const refused = (text: string): Prepared<never> => ({ ok: false, result: fail(text) })
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId, reach: 'driven', escape: null,
  })
  if (!found.ok) return { ok: false, result: found.result }
  const { run, task } = found.value
  const batch = run.batch
  if (batch === undefined) {
    return refused(`${run.run_id} is a per-task run: its tasks open PRs, and there is nothing to submit`)
  }
  if (task.phase !== 'implement' && task.phase !== 'sync') {
    return refused(`${task.task_id} is in ${task.phase}; submit answers only implement and sync`)
  }
  const kind = task.phase
  const checkout = task.checkout_path
  if (checkout === null) return refused(`${task.task_id} has no worktree on record, so there is nothing to submit from`)

  const title = input.title ?? (kind === 'sync' ? standingTitle(task) : null)
  if (title === null) {
    return refused(kind === 'implement'
      ? '--title is required: it is this change\'s line in the batch PR\'s release notes'
      : `--title is needed: no earlier submission of ${task.task_id} names this change`)
  }
  const titleCheck = checkReleaseTitle(title, releaseSections(checkout))
  if (!titleCheck.ok) return refused(titleCheck.error)

  const uncommitted = await uncommittedPaths(checkout)
  if (uncommitted === null) return refused(`git could not read the status of ${checkout}`)
  if (uncommitted.length > 0) {
    const more = uncommitted.length > 5 ? ', …' : ''
    return refused(`${checkout} has uncommitted or untracked work (${uncommitted.slice(0, 5).join(', ')}${more}): ` +
      'commit it or ignore it, and push — the check must test the pushed tree')
  }
  const head = await headOf(checkout)
  if (head === null) return refused(`git could not read HEAD in ${checkout}`)

  const fetchFailed = await fetchFromOrigin(checkout, trackingRefspec(batch.branch))
  if (fetchFailed !== null) return refused(`could not fetch ${batch.branch}: ${fetchFailed}`)
  const pushed = await remoteBranchHead(checkout, task.branch)
  if (!pushed.ok) return refused(`could not ask origin about ${task.branch}: ${pushed.reason}`)
  if (pushed.sha !== head) {
    return refused(`push first: origin has ${task.branch} at ${pushed.sha === null ? 'nothing' : sha8(pushed.sha)}, ` +
      `and HEAD is ${sha8(head)}`)
  }
  const batchRef = `refs/remotes/origin/${batch.branch}`
  const empty = await nothingToLand(checkout, batchRef)
  if (empty === null) return refused(`git could not compare ${task.branch} with ${batch.branch}`)
  if (empty) {
    return refused(`nothing to land: ${task.branch} has no change that ${batch.branch} lacks outside ${ARTIFACT_ROOT}/`)
  }

  let merge: SyncWalk | null = null
  if (kind === 'implement' && task.head_sha_at_entry !== null) {
    const sinceReview = await syncWalk(checkout, task.head_sha_at_entry, batchRef)
    if (sinceReview.clean) {
      return refused(`nothing but merges of ${batch.branch} since the review sent it back: commit the fixes, push, ` +
        'and submit again')
    }
  }
  if (kind === 'sync') {
    const current = await isAncestor(checkout, batchRef, head)
    if (current === null) return refused(`git could not compare ${task.branch} with ${batch.branch}`)
    if (!current) return refused(`still behind ${batch.branch}: merge it and push — ${mergeBatchCommand(batch)}`)
    merge = await syncWalk(checkout, task.land_sha ?? null, batchRef)
  }

  const open = await deps.openPr(run.repo_root, task.branch)
  if ('error' in open) {
    return refused(`could not ask GitHub whether ${task.branch} has an open PR (${open.error}); run it again`)
  }
  const pr = open.pr
  if (pr !== null) {
    return refused(`${task.branch} has an open PR, #${pr}, which would carry every sibling's commits into ` +
      `${batch.into}. Close PR #${pr}, then submit again`)
  }

  const check = repoCheck(checkout)
  if (check.kind === 'not-executable') {
    return refused(`${CHECK_REL} is not executable in ${checkout}: chmod +x ${CHECK_REL}, commit and push that, ` +
      'then submit again')
  }
  let outcome: CheckOutcome = 'none'
  if (check.kind === 'ready') {
    const log = join(checksDir(ctx.stateDir, run), `${task.task_id}-${sha8(head)}.log`)
    const ran = await (deps.runCheck ?? runCheck)(checkout, log)
    if (ran.code !== 0) {
      return refused(`${CHECK_REL} ${checkFailure(ran)}; its last lines:\n\n${ran.tail}\n\nthe whole log: ${log}`)
    }
    outcome = 'passed'
  }

  const submission: Submission = {
    kind, title, head_sha: head, at: Date.now(), check: outcome,
    ...(merge === null ? {} : merge.clean ? { merge: 'clean' } : { merge: 'dirty', dirty_at: merge.at }),
  }
  return {
    ok: true,
    value: {
      batch,
      prepared: {
        runId: run.run_id, taskId: task.task_id, kind, enteredAt: task.phase_entered_at,
        landSha: task.land_sha ?? null, submission, note: titleCheck.note,
      },
    },
  }
}

/** The quick part, retried on a stale save: nothing in it waits on the network or the check. */
async function recordSubmission(
  ctx: Ctx, prepared: PreparedSubmission, batch: Batch, repoKey: string | null,
): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: prepared.taskId, repoKey, runId: prepared.runId, reach: 'driven', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value
  if (task.phase !== prepared.kind || task.phase_entered_at !== prepared.enteredAt ||
    (task.land_sha ?? null) !== prepared.landSha) {
    return fail(`${task.task_id} moved on (now in ${task.phase}) while submit ran its checks; nothing was recorded — ` +
      'submit again if it still applies')
  }
  task.submission = prepared.submission
  await saveRun(ctx.stateDir, run)
  return ok([submittedLine(task, prepared.submission, batch), ...(prepared.note === null ? [] : [`note: ${prepared.note}`])]
    .join('\n'))
}

/** The single-PR worker's equivalent of opening a PR. Nothing is recorded unless every check passes. */
export async function cmdSubmit(
  ctx: Ctx, input: SubmitInput, deps: SubmitDeps = REAL_SUBMIT_DEPS,
): Promise<CmdResult> {
  const prepared = await prepareSubmission(ctx, input, deps)
  if (!prepared.ok) return prepared.result
  return retryingOnStale(recordSubmission)(ctx, prepared.value.prepared, prepared.value.batch, input.repoKey)
}

async function batchCheck(
  ctx: Ctx, input: { repoKey: string | null; runId: string | null },
  check: (checkout: string, logPath: string) => Promise<CheckRun>,
): Promise<Prepared<{ runId: string; checked: NonNullable<Batch['checked']>; batch: Batch }>> {
  const refused = (text: string): Prepared<never> => ({ ok: false, result: fail(text) })
  const found = await resolveFor(ctx, {
    runId: input.runId, repoKey: input.repoKey, phases: null, taskId: null, reach: 'driven',
  }, null)
  if (!found.ok) return { ok: false, result: found.result }
  const run = found.value
  const batch = run.batch
  if (batch === undefined) return refused(`${run.run_id} is a per-task run: there is no batch to check`)
  if (!existsSync(batch.checkout)) {
    return refused(`the batch checkout is not there yet; create it first:\n  ${checkoutSteps(run, false).join('\n  ')}`)
  }

  const fetchFailed = await fetchFromOrigin(run.repo_root, trackingRefspec(batch.branch))
  if (fetchFailed !== null) return refused(`could not fetch ${batch.branch}: ${fetchFailed}`)
  const head = await resolveCommit(run.repo_root, `refs/remotes/origin/${batch.branch}`)
  if (head === null) return refused(`origin/${batch.branch} does not resolve after the fetch`)
  const checkoutHead = await headOf(batch.checkout)
  if (checkoutHead !== head) {
    return refused(`the batch checkout is at ${checkoutHead === null ? 'nothing' : sha8(checkoutHead)}, not at ` +
      `origin/${batch.branch}'s ${sha8(head)}: push anything of its own, then bring it up to date with ` +
      `\`git -C ${shellQuoted(batch.checkout)} pull --ff-only\``)
  }
  const uncommitted = await uncommittedPaths(batch.checkout)
  if (uncommitted === null || uncommitted.length > 0) {
    return refused(`the batch checkout has uncommitted or untracked work (${(uncommitted ?? ['unreadable']).join(', ')}): ` +
      'commit and push it, or remove it, so the check tests what the PR carries')
  }

  const declared = repoCheck(batch.checkout)
  if (declared.kind === 'not-executable') {
    return refused(`${CHECK_REL} is not executable on ${batch.branch}: chmod +x ${CHECK_REL}, commit and push it`)
  }
  let outcome: CheckOutcome = 'none'
  if (declared.kind === 'ready') {
    const log = join(checksDir(ctx.stateDir, run), `batch-${sha8(head)}.log`)
    const ran = await check(batch.checkout, log)
    if (ran.code !== 0) {
      return refused(`${CHECK_REL} ${checkFailure(ran)} on ${batch.branch} at ${sha8(head)}; its last lines:` +
        `\n\n${ran.tail}\n\nthe whole log: ${log}`)
    }
    outcome = 'passed'
  }
  return { ok: true, value: { runId: run.run_id, batch, checked: { head_sha: head, at: Date.now(), check: outcome } } }
}

async function recordBatchCheck(
  ctx: Ctx, runId: string, checked: NonNullable<Batch['checked']>, repoKey: string | null,
): Promise<CmdResult> {
  const found = await resolveFor(ctx, { runId, repoKey, phases: null, taskId: null, reach: 'driven' }, null)
  if (!found.ok) return found.result
  const batch = found.value.batch
  if (batch === undefined) return fail(`${runId} is a per-task run: there is no batch to check`)
  batch.checked = checked
  await saveRun(ctx.stateDir, found.value)
  return ok(`checked ${batch.branch} at ${sha8(checked.head_sha)}: ` + (checked.check === 'passed'
    ? `${CHECK_REL} passed`
    : `no ${CHECK_REL} declared — run the tests and the typecheck in ${batch.checkout} yourself`))
}

/**
 * The one local run of every landing together, in the batch checkout at the head
 * just fetched. `ship` clears only once the PR's head is the head recorded here,
 * so a fix-task landing forces a fresh check before CI. The fetch and the check run
 * once, outside the retried save, for the reason `prepareSubmission` gives.
 */
export async function cmdBatchCheck(
  ctx: Ctx, input: { repoKey: string | null; runId: string | null },
  check: (checkout: string, logPath: string) => Promise<CheckRun> = runCheck,
): Promise<CmdResult> {
  const prepared = await batchCheck(ctx, input, check)
  if (!prepared.ok) return prepared.result
  return retryingOnStale(recordBatchCheck)(ctx, prepared.value.runId, prepared.value.checked, input.repoKey)
}

export type CloseBead = (repoKey: string, bead: string, reason: string, force: boolean) => Promise<Done | BdFailure>

const cliCloseBead = (stateDir: string): CloseBead => (repoKey, bead, reason, force) =>
  withCliBd(stateDir, repoKey, (bd) => bd.close(bead, reason, { force }))

/**
 * The fallback the close stall names once the reconciler's own close keeps
 * failing. It writes no ledger field: the next reconciler pass sees the bead
 * closed and records the edge itself, and a forced close is never undone because
 * the desired state is `closed` too.
 */
export async function cmdClose(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null; force: boolean
}, close: CloseBead = cliCloseBead(ctx.stateDir)): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (task.bead_closed_at_ms !== null) {
    return ok(`${task.bead} is already closed; the next supervisor pass tears ${task.task_id} down`)
  }
  if (task.merged_at_ms === null) {
    return fail(`no merge is recorded for ${task.task_id}, so its bead must not close yet — ` +
      `\`${hpipeCommand(ctx.pluginRoot)} rewind ${run.run_id} merge --task ${task.task_id}\` records it`)
  }
  const closed = await close(run.repo_key, task.bead, closeReason(task, run), input.force)
  if (isBdFailure(closed)) {
    return fail(`bd would not close ${task.bead}:\n  ${closed.error}` + (input.force
      ? ''
      : '\n  → --force overrides bd\'s close guards; use it only once you know why they fired'))
  }
  return ok(`closed ${task.bead}${input.force ? ' (forced)' : ''}; the next supervisor pass records it ` +
    `and tears ${task.task_id} down`)
}

async function release(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'finished-if-named', escape: '--run <run-id> releases it anyway',
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  // `escalated` is not `terminal` — it carries `escalated_from` so a human can
  // rewind it — but it has stopped moving and is a legitimate release target too.
  if (!taskRow(task.phase).terminal && task.phase !== 'escalated') {
    return fail(`task ${input.taskId} is still in flight (${task.phase})`)
  }

  task.files = []
  await saveRun(ctx.stateDir, run)
  return ok(`released ${input.taskId}; files reservation cleared`)
}
export const cmdRelease = retryingOnStale(release)

export interface NudgeDeps {
  readPane: ReadPaneLimit
  /** The live supervisor's holds, to say when a usage-limit hold is being released. */
  holds: () => Promise<Record<string, PaneHold>>
  /** Tells the supervisor to drop its usage-limit hold on the pane. */
  release: (paneId: string) => Promise<void>
}

const cliNudgeDeps = (ctx: Ctx): NudgeDeps => ({
  readPane: cliReadPaneLimit,
  holds: async () => {
    const state = await supervisorState(ctx.stateDir, ctx.session)
    return readPaneHolds(ctx.stateDir, ctx.session, state.state === 'live' ? state.info.pid : undefined)
  },
  release: async (paneId) => {
    await enqueueEvent(join(ctx.stateDir, 'queue', ctx.session), {
      kind: 'pipeline.nudge', session: ctx.session, at: Date.now(), pane_id: paneId,
    })
  },
})

/** Why a task is not nudged; `quiet` ones are left out of `--all`'s output, which lists them by id. */
interface NudgeRefusal { why: string; short: string }

/**
 * Only a worker Claude's usage limit stopped: its pane still shows the line, or
 * the supervisor holds it. An idle review worker waiting on its background
 * reviewer reads `done` too, and told the limit cut its subagent off it would
 * dispatch a second reviewer.
 */
async function nudgeRefusal(
  run: Run, task: Task, hpipe: string, deps: NudgeDeps, holds: Record<string, PaneHold>,
): Promise<NudgeRefusal | null> {
  const row = taskRow(task.phase)
  if (row.actor !== 'worker') {
    return { why: `${task.task_id} is in ${task.phase}, which does not wait on its worker; nothing to nudge`, short: task.phase }
  }
  if (task.pane_id === null) {
    return { why: `${task.task_id} has no agent pane — \`${hpipe} status\` says how to start one`, short: 'no pane' }
  }
  const unbriefed = unbriefedWorker(run, task)
  if (unbriefed !== null) {
    return { why: `${task.task_id}'s agent has not been handed its brief: ${briefCommand(task, unbriefed.paneId, hpipe)}`, short: 'unbriefed' }
  }
  if (queuedResume(run, task) !== null) {
    return { why: `${task.task_id}: a resume is already queued for ${task.pane_id}`, short: 'queued' }
  }
  if (queuedWorkerPrompt(run, task) !== null) {
    return { why: `${task.task_id}'s ${task.phase} prompt is queued and restarts it; nothing to nudge`, short: 'prompt queued' }
  }
  const reading = await deps.readPane(task.pane_id)
  if (reading?.status === 'working') {
    return { why: `${task.task_id}'s agent is working; nothing to nudge`, short: 'working' }
  }
  if (reading?.line == null && holds[task.pane_id]?.code !== 'usage_limit') {
    return {
      why: `${task.task_id}'s pane ${task.pane_id} shows no usage-limit message and the supervisor holds nothing for ` +
        `it; nudge only resumes a worker Claude's usage limit stopped — \`${hpipe} status\` says what it waits for`,
      short: 'no limit',
    }
  }
  return null
}

/**
 * Tells idle workers to carry on where they stopped — after Claude's usage limit,
 * or whenever one sits idle mid-phase. Unlike a same-phase rewind it touches no
 * phase, passes, verdict reservation or history, so a review in flight is not
 * dispatched twice. It restarts each one's stall ladder and releases the
 * supervisor's usage-limit hold on its pane.
 */
async function nudge(ctx: Ctx, input: {
  taskId: string | null; all: boolean; repoKey: string | null; runId: string | null
}, deps: NudgeDeps): Promise<CmdResult> {
  if ((input.taskId === null) === !input.all) return fail(commandUsage(USAGE.nudge as string[]))
  const hpipe = hpipeCommand(ctx.pluginRoot)
  let run: Run
  let candidates: Task[]
  if (input.taskId !== null) {
    const found = await resolveTask(ctx, {
      taskId: input.taskId, repoKey: input.repoKey, runId: input.runId, reach: 'driven', escape: null,
    })
    if (!found.ok) return found.result
    run = found.value.run
    candidates = [found.value.task]
  } else {
    const found = await resolveFor(ctx, {
      runId: input.runId, repoKey: input.repoKey, phases: null, taskId: null, reach: 'driven',
    }, null)
    if (!found.ok) return found.result
    run = found.value
    candidates = run.tasks.filter((t) => !taskPhaseIsTerminal(t.phase))
  }

  const holds = await deps.holds()
  const nudged: Task[] = []
  const skipped: Array<[Task, NudgeRefusal]> = []
  for (const task of candidates) {
    const refusal = await nudgeRefusal(run, task, hpipe, deps, holds)
    if (refusal === null) nudged.push(task)
    else skipped.push([task, refusal])
  }
  if (input.taskId !== null && skipped[0] !== undefined) return fail(skipped[0][1].why)
  const skippedLine = skipped.length === 0 ? [] :
    [`skipped: ${skipped.map(([t, r]) => `${t.task_id} (${r.short})`).join(', ')}`]
  if (nudged.length === 0) return ok(['nothing to nudge', ...skippedLine].join('\n'))

  const now = Date.now()
  for (const task of nudged) {
    const text = await renderPrompt(ctx.pluginRoot, 'usage-resume', {
      phase: task.phase, task_id: task.task_id, branch: task.branch,
    })
    enqueue(run, { to: 'worker', taskId: task.task_id, text, kind: 'resume' }, now)
    task.stall = freshLadder(run, task, now)
  }
  await saveRun(ctx.stateDir, run)

  const lines: string[] = []
  for (const task of nudged) {
    const pane = task.pane_id as string
    await deps.release(pane)
    const held = holds[pane]?.code === 'usage_limit'
    lines.push(`${task.task_id}: resume queued for ${pane} (${task.phase})` +
      (held ? "; the supervisor's usage-limit hold on it is released" : ''))
  }
  return ok([...lines, ...skippedLine].join('\n'))
}

export const cmdNudge = (ctx: Ctx, input: Parameters<typeof nudge>[1], deps: NudgeDeps = cliNudgeDeps(ctx)) =>
  retryingOnStale(nudge)(ctx, input, deps)

async function decide(ctx: Ctx, input: {
  task: string; question: string; recommendation: string
  repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  // Alone among the four, this refuses a finished run even when named: opening a
  // decision on one strands the question, because neither `rewind` (it leaves
  // run.phase alone) nor `resume` (it needs a prior abort) can get a worker back.
  // A parked run strands it too, until rewound: the supervisor announces nothing
  // on one, so the orchestrator never hears the question.
  const found = await resolveTask(ctx, {
    taskId: input.task, repoKey: input.repoKey, runId: input.runId,
    reach: 'driven', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (input.recommendation.trim().length === 0) {
    return fail('--recommend is required: a bare question pushes the call up to the orchestrator')
  }

  // decision_from records where the worker actually was; a second call while
  // already blocked-on-decision would overwrite it with 'blocked-on-decision'
  // itself, stranding the task with no phase to rewind back to.
  if (task.phase === 'blocked-on-decision') {
    return fail(`task ${input.task} already has an open decision: ${openDecisionFor(task)?.id}`)
  }

  // Mirrors cmdAnswer's guard. Nothing should move a finished task into a live
  // phase; #38 did exactly that to two tasks whose worktrees were already gone.
  if (taskPhaseIsTerminal(task.phase)) {
    return fail(`task ${input.task} is finished (phase: ${task.phase}) — ` +
      'it cannot be blocked on a decision')
  }

  task.decision_from = task.phase
  const decision = openDecision(task, { question: input.question, recommendation: input.recommendation })
  enterTaskPhase(run, task, 'blocked-on-decision', 'worker surfaced a decision')
  await saveRun(ctx.stateDir, run)
  return ok(`opened decision ${decision.id} on ${input.task}; task blocked-on-decision`)
}
export const cmdDecide = retryingOnStale(decide)

async function answer(ctx: Ctx, input: {
  task: string; decision: string; answer: string; by: 'orchestrator' | 'human'
  repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.task, repoKey: input.repoKey, runId: input.runId,
    reach: 'finished-if-named',
    escape: '--run <run-id> records an answer on it anyway',
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (input.by !== 'orchestrator' && input.by !== 'human') {
    return fail(`--by must be 'orchestrator' or 'human', got: ${input.by}`)
  }

  if (task.phase !== 'blocked-on-decision') {
    return fail(`task ${input.task} is not blocked on a decision (phase: ${task.phase})`)
  }

  let decision
  try {
    decision = answerDecision(task, input.decision, input.answer, input.by)
  } catch {
    return fail(`no such decision: ${input.decision}`)
  }

  // Delivery is a separate step (Task 20): writing the answer must not resume
  // the task, or a slow worker's late file touch would complete the phase unread.
  task.pending_answer = decision.id
  task.delivery_attempts = 0
  delete task.answer_sent_at
  await saveRun(ctx.stateDir, run)
  return ok(`recorded answer to ${decision.id} on ${input.task}; pending delivery`)
}
export const cmdAnswer = retryingOnStale(answer)

async function escalate(ctx: Ctx, input: {
  taskId: string; decisionId: string; recommendation: string
  repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  if (input.decisionId.trim().length === 0) return fail('--decision is required')
  if (input.recommendation.trim().length === 0) {
    return fail('--recommend is required: the human gets your recommendation beside the worker\'s')
  }
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  const decision = task.decisions.find((d) => d.id === input.decisionId)
  if (!decision) return fail(`no such decision: ${input.decisionId}`)
  if (decision.answered_by !== null) {
    return fail(`decision ${decision.id} on ${task.task_id} is already ${decision.answered_by === 'abandoned' ? 'abandoned' : 'answered'}`)
  }
  if (task.phase !== 'blocked-on-decision') {
    return fail(`task ${task.task_id} is not blocked on a decision (phase: ${task.phase})`)
  }
  if (decision.escalated_at !== null) {
    const kept = decision.orchestrator_recommendation !== input.recommendation
      ? `; the original recommendation was kept: ${decision.orchestrator_recommendation ?? '(none given)'}`
      : ''
    return ok(`decision ${decision.id} on ${task.task_id} is already with the human; nothing changed${kept}`)
  }

  decision.escalated_at = Date.now()
  decision.orchestrator_recommendation = input.recommendation
  await saveRun(ctx.stateDir, run)
  return ok(`decision ${decision.id} on ${task.task_id} is now with the human; its bead shows blocked until ` +
    `\`${hpipeCommand(ctx.pluginRoot)} answer --task ${task.task_id} --decision ${decision.id} --answer "<their ruling>" --by human\` ` +
    'records their ruling')
}
export const cmdEscalate = retryingOnStale(escalate)

/** The worker's way to keep an out-of-scope find out of its PR. No Beads access: the orchestrator files it. */
async function discover(ctx: Ctx, input: {
  taskId: string; title: string; bodyFile: string; repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  if (input.title.trim().length === 0) return fail('--title is required')
  if (input.title.startsWith('--')) {
    return fail(`--title got a flag where the title belongs: "${input.title}" — the value after --title is missing`)
  }
  const bodyPath = resolve(input.bodyFile)
  if (input.bodyFile.trim().length === 0 || !isReadableFile(bodyPath)) return fail(`--body-file is not a file: ${bodyPath}`)

  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  const id = `x${task.discoveries.length + 1}`
  const dir = join(ctx.stateDir, 'runs', run.session, `${run.run_id}.discoveries`)
  mkdirSync(dir, { recursive: true })
  const bodyCopy = join(dir, `${task.task_id}-${id}-${randomUUID().slice(0, 8)}.md`)
  copyFileSync(bodyPath, bodyCopy, fsConstants.COPYFILE_EXCL)
  task.discoveries.push({ id, title: input.title, body_path: bodyCopy, filed_bead: null })
  try {
    await saveRun(ctx.stateDir, run)
  } catch (error) {
    rmSync(bodyCopy, { force: true })
    throw error
  }
  return ok(`recorded ${task.task_id}/${id}; the orchestrator files it after the run — keep it out of this PR`)
}
export const cmdDiscover = retryingOnStale(discover)

function discoveryList(run: Run): string {
  const lines = run.tasks.flatMap((task) => task.discoveries.map((d) =>
    `${task.task_id}/${d.id} ${d.filed_bead === null ? 'unfiled' : `filed as ${d.filed_bead}`} — ${d.title} (${d.body_path})`))
  return lines.length === 0 ? `no discoveries recorded in ${run.run_id}` : lines.join('\n')
}

/** Saved the moment a bead exists, so a retry finds it filed and files nothing twice. Returns why it was not saved, or null. */
async function recordFiled(
  ctx: Ctx, runId: string, taskId: string, discoveryId: string, bead: string,
): Promise<string | null> {
  try {
    await retryOnStaleRun(async () => {
      const run = await runById(ctx.stateDir, ctx.session, runId)
      const found = run?.tasks.find((t) => t.task_id === taskId)?.discoveries.find((d) => d.id === discoveryId)
      if (!run || !found) throw new Error(`${taskId}/${discoveryId} is gone from the ledger`)
      found.filed_bead = bead
      await saveRun(ctx.stateDir, run)
    })
    return null
  } catch (error) {
    if (isUnlandedSave(error)) return 'the ledger kept changing under the save'
    return error instanceof Error ? error.message : String(error)
  }
}

export type FileDiscovery = (
  repoKey: string, input: BeadCreateInput, dedupeLabel: string,
) => Promise<CreatedBead | BdFailure>

/**
 * A create whose ledger save failed leaves a bead carrying the discovery's label, so look for it
 * first: the retry adopts that bead instead of filing a second one.
 */
export async function fileUnlessFiled(
  bd: Pick<Bd, 'refreshExport' | 'readExport' | 'create'>, input: BeadCreateInput, dedupeLabel: string,
): Promise<CreatedBead | BdFailure> {
  const refreshed = await bd.refreshExport()
  if (isBdFailure(refreshed)) return refreshed
  const existing = bd.readExport().find((bead) => bead.labels?.includes(dedupeLabel))
  return existing === undefined ? bd.create({ ...input, labels: [...input.labels, dedupeLabel] }) : { id: existing.id }
}

const cliFileDiscovery = (stateDir: string): FileDiscovery => (repoKey, input, label) =>
  withCliBd(stateDir, repoKey, (bd) => fileUnlessFiled(bd, input, label))

export async function cmdDiscoveries(ctx: Ctx, input: {
  repoKey: string | null; runId: string | null; file: boolean
}, fileBead: FileDiscovery = cliFileDiscovery(ctx.stateDir)): Promise<CmdResult> {
  const found = await resolveFor(ctx, {
    runId: input.runId, repoKey: input.repoKey, phases: null, taskId: null, reach: 'finished-if-named',
  }, '--run <run-id> lists them anyway')
  if (!found.ok) return found.result
  const runId = found.value.run_id
  if (!input.file) return ok(discoveryList(found.value))

  const pending = found.value.tasks.flatMap((task) =>
    task.discoveries.filter((d) => d.filed_bead === null).map((d) => ({ taskId: task.task_id, discoveryId: d.id })))
  for (const { taskId, discoveryId } of pending) {
    const run = await runById(ctx.stateDir, ctx.session, runId)
    const task = run?.tasks.find((t) => t.task_id === taskId)
    const current = task?.discoveries.find((d) => d.id === discoveryId)
    if (!run || !task || !current || current.filed_bead !== null) continue
    let body: string
    try {
      body = readFileSync(current.body_path, 'utf8')
    } catch {
      return fail(`${taskId}/${discoveryId}'s body copy is missing: ${current.body_path}; nothing after it was filed`)
    }
    const created = await fileBead(run.repo_key, {
      title: current.title, body, labels: [DISCOVERED_LABEL], depsDiscoveredFrom: task.bead,
    }, discoveryLabel(runId, taskId, discoveryId))
    if (isBdFailure(created)) {
      const now = (await runById(ctx.stateDir, ctx.session, runId)) ?? run
      return fail(`${discoveryList(now)}\nfiling ${taskId}/${discoveryId} failed; nothing after it was filed:\n  ${created.error}`)
    }
    const unsaved = await recordFiled(ctx, runId, taskId, discoveryId, created.id)
    if (unsaved !== null) {
      return fail(`${taskId}/${discoveryId} was filed as ${created.id}, but ${unsaved} — do not file it again`)
    }
  }
  const after = await runById(ctx.stateDir, ctx.session, runId)
  return ok(discoveryList(after ?? found.value))
}

async function tier(ctx: Ctx, input: {
  taskId: string; tier: string; why: string; callerPane: string | null
  repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const to = input.tier
  if (!isTier(to)) return fail(`the tier must be one of ${TIERS.join(', ')}, got: ${to || '(missing)'}`)
  if (input.why.trim().length === 0) {
    return fail('--why is required: the tier log records why every change was made')
  }

  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (taskPhaseIsTerminal(task.phase)) {
    return fail(`task ${task.task_id} is finished (phase: ${task.phase}) — its tier routes nothing now`)
  }
  const from = tierOf(task)
  if (from === to) return ok(`${task.task_id} is already ${to}; nothing changed`)
  if (isLowering(from, to) && input.callerPane !== null && pipelinePanes(run).has(input.callerPane)) {
    return fail('lowering a tier needs a human; run this from your own pane')
  }

  task.tier = to
  task.tier_history = [...(task.tier_history ?? []), {
    at: Date.now(), from, to, source: 'hpipe-tier', pane: input.callerPane, why: input.why,
  }]
  await saveRun(ctx.stateDir, run)
  return ok(`${task.task_id}: ${from} → ${to}. ${task.phase} completes as it is; the next step follows ${to}. ` +
    `Its reviews now run at effort ${REVIEW_EFFORT[to]}; the worker keeps the effort it was started with.`)
}
export const cmdTier = retryingOnStale(tier)

export type ShowBead = RegistrationBeads['show']

/** The only way an agent reads Beads: agents never run `bd`. */
export async function cmdBeadShow(ctx: Ctx, input: { repoKey: string; id: string },
  show: ShowBead = cliRegistrationBeads(ctx.stateDir).show): Promise<CmdResult> {
  const id = input.id.trim()
  if (id.length === 0) return fail(commandUsage(USAGE.bead ?? []))
  const bead = await show(input.repoKey, id)
  if (isBdFailure(bead)) return fail(`bd show ${id} failed:\n  ${bead.error}`)
  return ok(formatBeadDetail(bead))
}

export type TriageFor = (repoKey: string) => Promise<TriageOutput | BdFailure>

const cliTriage = (stateDir: string): TriageFor => async (repoKey) => {
  const bd = await cliBd(stateDir, repoKey)
  if (isBdFailure(bd)) return bd
  const bvBroken = bvProblem(await checkBv())
  if (bvBroken !== null) return { reason: 'unavailable', error: bvBroken }
  // A failed refresh still leaves the last good export to triage, a write or two behind.
  await bd.refreshExport()
  return bvTriage(stateDir, beadsSlug(repoKey))
}

export async function cmdNext(ctx: Ctx, input: { repoKey: string; limit: number; label: string | null },
  triage: TriageFor = cliTriage(ctx.stateDir)): Promise<CmdResult> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    return fail(`--limit must be a positive whole number, got: ${input.limit}`)
  }
  const result = await triage(input.repoKey)
  if (isBdFailure(result)) return fail(result.error)
  const held = new Set((await beadHolds(ctx.stateDir)).keys())
  return ok(formatNext(result, held, { limit: input.limit, label: input.label }))
}

export async function cmdStatus(ctx: Ctx, tools: () => Promise<Tools> = checkTools): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const state = await supervisorState(ctx.stateDir, ctx.session)
  const herdr = new Herdr()
  const { livePanes, panes } = await observePanes(
    () => herdr.paneList(), ctx.stateDir, ctx.session,
    state.state === 'live' ? state.info.pid : undefined,
  )
  return ok(formatStatus(
    runs,
    {
      state: state.state, pid: 'info' in state ? state.info.pid : undefined,
      schemas: 'info' in state ? drivenSchemas(state.info) : undefined,
    },
    ctx.session,
    hpipeCommand(ctx.pluginRoot),
    livePanes,
    Date.now(),
    panes,
    toolsLine(await tools()),
  ))
}

export async function cmdDrain(ctx: Ctx): Promise<CmdResult> {
  const events = await drain(join(ctx.stateDir, 'queue', ctx.session))
  return ok(events.length === 0 ? 'queue empty' : JSON.stringify(events, null, 2))
}

async function abort(ctx: Ctx, input: { runId: string }): Promise<CmdResult> {
  const run = await runById(ctx.stateDir, ctx.session, input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  // Record where it was so resume can put it back. Worktrees and branches are untouched.
  run.history.push({ at: Date.now(), from: run.phase, to: 'done', why: `aborted from ${run.phase}` })
  run.escalated_from = run.phase
  run.phase = 'done'
  await saveRun(ctx.stateDir, run)
  const undo = `Undo: hpipe resume ${run.run_id}`
  if (run.batch === undefined) {
    return ok(`aborted ${run.run_id}; worktrees and branches left alone, and its beads are released on the ` +
      `supervisor's next tick. ${undo}`)
  }
  return ok([`aborted ${run.run_id}; ${abortedBatch(run, run.batch)} ${undo}`, ...(await cleanupLines(run, run.batch))]
    .join('\n'))
}

/** A landed task's bead stays closed through an abort: its commits are on the batch branch, which nothing deletes. */
function abortedBatch(run: Run, batch: Batch): string {
  const landed = run.tasks.filter((t) => (t.landed ?? []).length > 0).map((t) => t.task_id)
  const kept = landed.length === 0
    ? `nothing landed on ${batch.branch}`
    : `${batch.branch} keeps the landed tasks (${landed.join(', ')}), whose beads stay closed`
  const pr = batch.pr === null ? '' : ` PR #${batch.pr} is left open.`
  return `${kept}, and nothing reached ${batch.into}. Worktrees and branches are left alone, and the unlanded ` +
    `tasks' beads are released on the supervisor's next tick.${pr}`
}
export const cmdAbort = retryingOnStale(abort)

async function resume(ctx: Ctx, input: { runId: string }): Promise<CmdResult> {
  const run = await runById(ctx.stateDir, ctx.session, input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  if (!wasAborted(run) || !run.escalated_from) {
    return fail(`${run.run_id} was not aborted — nothing to resume`)
  }

  const back = run.escalated_from
  const taken = await beadsTakenMeanwhile(ctx, run, run.tasks.filter((task) => holdsBead({ phase: back }, task)))
  if (taken !== null) return fail(`${run.run_id} was not resumed:\n${taken}`)
  run.history.push({ at: Date.now(), from: 'done', to: back, why: 'resumed' })
  run.phase = back
  run.escalated_from = null
  run.phase_entered_at = Date.now()
  await saveRun(ctx.stateDir, run)
  return ok(`resumed ${run.run_id} at ${back}`)
}
export const cmdResume = retryingOnStale(resume)

async function forget(ctx: Ctx, input: { workspaceId: string }): Promise<CmdResult> {
  const run = await runForWorkspace(ctx.stateDir, ctx.session, input.workspaceId)
  const task = run?.tasks.find((t) => t.workspace_id === input.workspaceId)
  if (!run || !task) return fail(`no task is bound to ${input.workspaceId}`)

  task.workspace_id = null
  task.pane_id = null
  await saveRun(ctx.stateDir, run)
  return ok(`unbound ${input.workspaceId} from ${task.task_id}`)
}
export const cmdForget = retryingOnStale(forget)

// ——— argv dispatcher ———

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? null)
}

// Exported for its tests: `dispatch` is module-private, so this is the only
// importable symbol on the argv layer where the --files bug lived. It proves the
// helper; `test/cli-argv.test.ts` drives the real binary and proves the wiring.
export function listFlag(argv: string[], name: string): string[] {
  const entries: string[] = []
  // Every occurrence contributes. `flag` is indexOf-based, so the previous
  // single-lookup form silently dropped a repeated --files and everything it
  // declared, with no diagnostic anywhere.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${name}`) continue
    const raw = argv[i + 1]
    if (raw === undefined) continue
    entries.push(...raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
  }
  return entries
}

function withoutFlag(argv: string[], name: string): string[] {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)]
}

function positionals(argv: string[]): string[] {
  const found: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (!arg.startsWith('--')) found.push(arg)
    else if (!VALUELESS_FLAGS.has(arg)) i++
  }
  return found
}

const USAGE: Record<string, string[]> = {
  start: ['hpipe start <title> [--prefix <bead-prefix>] [--single-pr [--batch-branch <name>]]'],
  task: ['hpipe task --branch <branch> (--bead <id> | --title <title> --body-file <path> ' +
    '[--acceptance-file <path>]) --surface <surface> [--tier light|standard|heavy] ' +
    '[--depends-on <id,id>] [--files <prefix,prefix>] [--notes <text>] [--keep-worktree] [--run <run-id>]'],
  brief: ['hpipe brief --task <id> [--run <run-id>]'],
  show: ['hpipe show --task <id> [--run <run-id>]'],
  bead: ['hpipe bead show <id>'],
  next: ['hpipe next [--limit <n>] [--label <label>]   (--label filters bv\'s top 10 recommendations, not every bead)'],
  dispatch: [
    'hpipe dispatch --task <id> --pane <pane-id> [--run <run-id>]',
    'hpipe dispatch --done [--run <run-id>]',
  ],
  status: ['hpipe status'],
  drain: ['hpipe drain'],
  rewind: ['hpipe rewind <run-id> <phase> [--task <id>]'],
  release: ['hpipe release --task <id> [--run <run-id>]'],
  nudge: ['hpipe nudge (--task <id> | --all) [--run <run-id>]'],
  decide: ['hpipe decide --task <id> --question <text> --recommend <text> [--run <run-id>]'],
  escalate: ['hpipe escalate --task <id> --decision <id> --recommend <text> [--run <run-id>]'],
  discover: ['hpipe discover --task <id> --title <title> --body-file <path> [--run <run-id>]'],
  discoveries: ['hpipe discoveries [--file] [--run <run-id>]'],
  answer: ['hpipe answer --task <id> --decision <id> --answer <text> --by orchestrator|human [--run <run-id>]'],
  tier: ['hpipe tier --task <id> <light|standard|heavy> --why <text> [--run <run-id>]'],
  resume: ['hpipe resume <run-id>'],
  abort: ['hpipe abort <run-id>'],
  forget: ['hpipe forget <workspace-id>'],
  close: ['hpipe close --task <id> [--force] [--run <run-id>]'],
  submit: ['hpipe submit --task <id> [--title "<conventional title>"] [--run <run-id>]'],
  'batch-check': ['hpipe batch-check [--run <run-id>]'],
}

const commandUsage = (forms: string[]): string => `usage: ${forms.join('\n       ')}`

const fullUsage = (): string =>
  `usage: hpipe <${Object.keys(USAGE).join('|')}> …\n\n` +
  Object.values(USAGE).flat().map((form) => `  ${form}`).join('\n')

const HELP_FLAGS = new Set(['--help', '-h'])
const VALUELESS_FLAGS = new Set(['--done', '--keep-worktree', '--force', '--file', '--all', '--single-pr', ...HELP_FLAGS])
// Prose can legitimately be `-h`. An identifier never can: taking one as a value
// registered a task on branch `-h`.
const FREE_TEXT_FLAGS = new Set(['--question', '--recommend', '--answer', '--notes', '--title', '--why'])
// cmdTask names this one's argv accident more precisely than a usage line can.
const SELF_VALIDATING_FLAGS = new Set(['--files'])

const wantsHelp = (args: string[]): boolean => args.some((arg, i) => {
  if (!HELP_FLAGS.has(arg)) return false
  const previous = args[i - 1]
  return previous === undefined || !FREE_TEXT_FLAGS.has(previous)
})

/** The first identifier flag whose value is missing or looks like a flag. */
function identifierWithoutValue(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const name = args[i] as string
    if (!name.startsWith('--') || VALUELESS_FLAGS.has(name)) continue
    if (FREE_TEXT_FLAGS.has(name) || SELF_VALIDATING_FLAGS.has(name)) { i++; continue }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('-')) return name
    i++
  }
  return null
}

const DISPATCH_CONFIRM_TIMEOUT_MS = 30_000

async function dispatch(argv: string[]): Promise<number> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
    ?? join(process.env.HOME ?? '', '.local/state/herdr/plugins/stein.pipeline')
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, '..')
  const ctx: Ctx = { stateDir, pluginRoot, session: sessionKey() }
  const [command, ...rest] = argv

  if (command === 'help' || (command !== undefined && HELP_FLAGS.has(command))) {
    console.log(fullUsage())
    return 0
  }
  const usage = command !== undefined && Object.hasOwn(USAGE, command) ? USAGE[command] : undefined
  if (command === undefined || usage === undefined) {
    console.error(fullUsage())
    return 1
  }
  // Before the repo lookup and every write: `start --help` used to open a run
  // titled "--help", and `resume --help` looked for a run with that id.
  if (wantsHelp(rest)) {
    console.log(commandUsage(usage))
    return 0
  }
  if (command === 'dispatch' && rest.includes('--done') === (flag(rest, 'task') !== null)) {
    console.error(commandUsage(usage))
    return 1
  }
  const valueless = command === 'start' ? null : identifierWithoutValue(rest)
  if (valueless !== null) {
    console.error(`hpipe: ${valueless} needs a value\n${commandUsage(usage)}`)
    return 1
  }

  // Every command that resolves a run needs the caller's repo to filter by, so
  // this is a deny-list, not an allow-list: a new command is assumed to resolve.
  // Get it wrong that way and it fails loudly outside a repo; get an allow-list
  // wrong and the new command silently gets repoKey: null, which is #21 again
  // with no error anywhere. These six address a run by id, or not at all.
  const byIdOrNothing = ['status', 'drain', 'abort', 'resume', 'forget', 'rewind']
  // --run names the run outright, so the lookup is skipped; `start` has no --run.
  // These address a repo's Beads store, never a run, so --run cannot stand in for the repo.
  const storeCommands = ['bead', 'next']
  const needsRepo = command === 'start' || storeCommands.includes(command ?? '') ||
    (!byIdOrNothing.includes(command ?? '') && flag(rest, 'run') === null)
  const repo = needsRepo ? await repoContext() : null
  if (needsRepo && !repo) {
    console.error(command === 'start'
      ? 'hpipe: not inside a git repository'
      : 'hpipe: not inside a git repository — run it from the repo whose run you mean, or pass --run <run-id>')
    return 1
  }

  let out: CmdResult
  switch (command) {
    case 'start': {
      const prefix = flag(rest, 'prefix')
      if (rest.includes('--prefix') && (prefix === null || prefix.startsWith('--'))) {
        out = fail('--prefix needs a value: hpipe start <title> --prefix <bead-prefix>')
        break
      }
      const batchBranch = flag(rest, 'batch-branch')
      if (rest.includes('--batch-branch') && (batchBranch === null || batchBranch.startsWith('--'))) {
        out = fail('--batch-branch needs a value: hpipe start <title> --single-pr --batch-branch <name>')
        break
      }
      const words = withoutFlag(withoutFlag(rest.filter((arg) => arg !== '--single-pr'), 'prefix'), 'batch-branch')
      out = await cmdStart(ctx, {
        title: words.join(' ').trim(),
        prefix,
        singlePr: rest.includes('--single-pr'),
        batchBranch,
        repoKey: repo!.repoKey, repoRoot: repo!.repoRoot,
        socketPath: process.env.HERDR_SOCKET_PATH ?? '',
        paneId: process.env.HERDR_PANE_ID ?? '',
        workspaceId: process.env.HERDR_WORKSPACE_ID ?? '',
      })
      break
    }

    case 'task':
      out = await cmdTask(ctx, {
        branch: flag(rest, 'branch') ?? '',
        bead: flag(rest, 'bead') ?? undefined,
        surface: flag(rest, 'surface') ?? '',
        notes: flag(rest, 'notes') ?? '',
        dependsOn: listFlag(rest, 'depends-on'),
        files: listFlag(rest, 'files'),
        keepWorktree: rest.includes('--keep-worktree'),
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
        title: flag(rest, 'title') ?? undefined,
        bodyFile: flag(rest, 'body-file') ?? undefined,
        acceptanceFile: flag(rest, 'acceptance-file') ?? undefined,
        tier: flag(rest, 'tier') ?? undefined,
        callerPane: process.env.HERDR_PANE_ID || null,
      })
      break

    case 'brief':
      out = await cmdBrief(ctx, {
        taskId: flag(rest, 'task') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'show':
      out = await cmdShow(ctx, {
        taskId: flag(rest, 'task') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'dispatch':
      if (rest.includes('--done')) {
        out = await cmdDispatchDone(ctx, {
          runId: flag(rest, 'run'), repoKey: repo?.repoKey ?? null,
        })
        break
      }
      out = await cmdDispatchTask(ctx, {
        taskId: flag(rest, 'task')!,
        paneId: flag(rest, 'pane') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      }, (paneId, text) => new Herdr().agentPromptConfirmed(paneId, text, DISPATCH_CONFIRM_TIMEOUT_MS))
      break

    case 'rewind':
      out = await cmdRewind(ctx, {
        runId: rest[0] ?? '', phase: rest[1] ?? '', taskId: flag(rest, 'task'),
      })
      break

    case 'nudge':
      out = await cmdNudge(ctx, {
        taskId: flag(rest, 'task') ?? null,
        all: rest.includes('--all'),
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'release':
      out = await cmdRelease(ctx, {
        taskId: flag(rest, 'task') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'decide':
      out = await cmdDecide(ctx, {
        task: flag(rest, 'task') ?? '',
        question: flag(rest, 'question') ?? '',
        recommendation: flag(rest, 'recommend') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'answer':
      out = await cmdAnswer(ctx, {
        task: flag(rest, 'task') ?? '',
        decision: flag(rest, 'decision') ?? '',
        answer: flag(rest, 'answer') ?? '',
        by: (flag(rest, 'by') ?? '') as 'orchestrator' | 'human',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'escalate':
      out = await cmdEscalate(ctx, {
        taskId: flag(rest, 'task') ?? '',
        decisionId: flag(rest, 'decision') ?? '',
        recommendation: flag(rest, 'recommend') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'discover':
      out = await cmdDiscover(ctx, {
        taskId: flag(rest, 'task') ?? '',
        title: flag(rest, 'title') ?? '',
        bodyFile: flag(rest, 'body-file') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'discoveries':
      out = await cmdDiscoveries(ctx, {
        repoKey: repo?.repoKey ?? null, runId: flag(rest, 'run'), file: rest.includes('--file'),
      })
      break

    case 'tier':
      out = await cmdTier(ctx, {
        taskId: flag(rest, 'task') ?? '',
        tier: positionals(rest)[0] ?? '',
        why: flag(rest, 'why') ?? '',
        callerPane: process.env.HERDR_PANE_ID || null,
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'batch-check':
      out = await cmdBatchCheck(ctx, { repoKey: repo?.repoKey ?? null, runId: flag(rest, 'run') })
      break

    case 'submit':
      out = await cmdSubmit(ctx, {
        taskId: flag(rest, 'task') ?? '',
        title: flag(rest, 'title'),
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'close':
      out = await cmdClose(ctx, {
        taskId: flag(rest, 'task') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
        force: rest.includes('--force'),
      })
      break

    case 'bead': {
      const [subcommand, id] = positionals(rest)
      if (subcommand !== 'show') {
        console.error(commandUsage(usage))
        return 1
      }
      out = await cmdBeadShow(ctx, { repoKey: repo!.repoKey, id: id ?? '' })
      break
    }

    case 'next':
      out = await cmdNext(ctx, {
        repoKey: repo!.repoKey,
        limit: Number(flag(rest, 'limit') ?? '5'),
        label: flag(rest, 'label'),
      })
      break

    case 'status': out = await cmdStatus(ctx); break
    case 'drain': out = await cmdDrain(ctx); break
    case 'abort': out = await cmdAbort(ctx, { runId: rest[0] ?? '' }); break
    case 'resume': out = await cmdResume(ctx, { runId: rest[0] ?? '' }); break
    case 'forget': out = await cmdForget(ctx, { workspaceId: rest[0] ?? '' }); break

    default:
      console.error(fullUsage())
      return 1
  }

  console.log(out.text)
  return out.ok ? 0 : 1
}

if (import.meta.main) process.exit(await dispatch(process.argv.slice(2)))
