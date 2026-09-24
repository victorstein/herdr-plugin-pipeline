import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrapLine, repoBootstrap } from '../lib/bootstrap'
import { openDecisionFor } from '../lib/decisions'
import { gateStatus, planDeclaredFiles, releasableFromFiles, widenFiles } from '../lib/gating'
import type { RunEffect } from '../lib/ledger'
import type { IssueView, PrView } from '../lib/gh'
import { advanceTask, counterFor, enterTaskPhase } from '../lib/machine'
import { taskRow } from '../lib/phases'
import { isFresh, isSettled, type VerdictResult } from '../lib/predicates'
import { renderPrompt } from '../lib/render'
import { artifactBase, reserveVerdict } from '../lib/verdict-path'
import { renderWorkerPrompt } from '../lib/worker-prompt'
import type { Run, Task, TaskPhase } from '../lib/types'
import { absoluteArtifactPath, adoptableArtifacts, warnToTick } from './deliver'
import { runTeardown, type WorktreeRemoval } from './teardown'

export interface TaskDeps {
  pluginRoot: string
  /**
   * Live `herdr agent status` read on a pane, already double-checked after
   * ACTOR_SETTLE_MS by the caller. NOT task.agent_status, which is the badge and
   * wake cache and can be stale by a whole turn.
   */
  liveIdle: (paneId: string) => Promise<boolean>
  maxPasses: number
  fileSettleMs: number
  prForBranch: (branch: string) => Promise<number | null>
  prView: (pr: number) => Promise<PrView | null>
  issueView: (issue: number) => Promise<IssueView | null>
  verdictFor: (run: Run, task: Task) => Promise<VerdictResult | null>
  removeWorktree: (workspaceId: string) => Promise<WorktreeRemoval>
  /** Rendered detail of the failing checks, for the ci-red prompt. */
  ciDetail: (pr: number | null) => Promise<string>
  /**
   * Phase entries whose ambiguous candidate set has already been reported. Owned
   * by main()'s loop so cross-tick dedup has one owner, not a module-level twin.
   */
  ambiguityLog: Set<string>
  /** Collects what this tick did outside the ledger; see `saveOrReapply`. */
  effects?: RunEffect[]
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

  const common = {
    run_id: run.run_id,
    branch: task.branch,
    issue: String(task.issue),
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
    case 'pr-review-intent':
      return renderPrompt(deps.pluginRoot, 'pr-review-intent', common)
    case 'pr-review-quality':
      return renderPrompt(deps.pluginRoot, 'pr-review-quality', common)
    case 'merge':
      return renderPrompt(deps.pluginRoot, 'merge', common)
    case 'close':
      return task.issue_closed_at_entry ? '' : renderPrompt(deps.pluginRoot, 'close', common)
    case 'implement':
      // Re-entry from a red CI needs the failing checks inlined; every other
      // entry gets the standing brief, which points a returning worker at the
      // review file that sent it back.
      return cameFrom === 'ci'
        ? renderPrompt(deps.pluginRoot, 'ci-red', {
            ...common, ci_failure: await deps.ciDetail(task.pr),
          })
        : renderPrompt(deps.pluginRoot, 'implement', common)
    case 'escalated': {
      const from = task.escalated_from ?? cameFrom
      return renderPrompt(deps.pluginRoot, 'escalate', {
        run_id: run.run_id,
        phase: from,
        pass: String(counterFor(task, from)),
        task_flag: ` --task ${task.task_id}`,
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
  await runTeardown([run], deps.removeWorktree, deps.effects)

  for (const task of run.tasks) {
    if (task.phase === 'queued') {
      const gate = gateStatus(task, run.tasks)
      if (gate.state === 'blocked-on-failure') {
        enterTaskPhase(run, task, 'blocked-on-failure', `depends on ${gate.on.join(', ')}`)
        continue
      }
      if (gate.state !== 'ready') continue

      enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'gate opened')
      prompts.push({
        text: `Dispatch ${task.task_id} (${task.branch}, #${task.issue}) — ` +
          `worktree create --cwd ${run.repo_root}:\n` +
          `${bootstrapLine(repoBootstrap(run.repo_root))}\n\n` +
          (await renderWorkerPrompt(deps.pluginRoot, run, task)),
        paneId: run.orchestrator_pane,
        taskId: task.task_id,
      })
      continue
    }

    const row = taskRow(task.phase)
    const pane = actorPane(run, task)
    if (row.actor !== undefined && pane === null) continue
    const actorIdle = pane === null ? false : await deps.liveIdle(pane)

    // Phases whose signal comes from the orchestrator must not be evaluated
    // while it is mid-turn, exactly as run phases are gated.
    if (row.actor === 'orchestrator' && !actorIdle) continue

    const signals = await gatherSignals(run, task, deps, actorIdle)
    if (!signals) continue

    const cameFrom = task.phase
    if (!advanceTask(run, task, signals)) continue
    if (task.phase === cameFrom) continue

    const prompt = await promptForTaskPhase(run, task, deps, cameFrom)
    if (prompt.length > 0) {
      prompts.push({ text: prompt, paneId: actorPane(run, task), taskId: task.task_id })
    }
  }

  return prompts
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
  const added = widenFiles(task.files, declared)
  if (added.length === 0) return
  task.files = [...task.files, ...added]
  console.error(
    `[pipeline] ${task.task_id} (${task.branch}): plan widened files by ` +
    added.map((path) => (path === '' ? '(whole repo)' : path)).join(', '),
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

async function gatherSignals(run: Run, task: Task, deps: TaskDeps, actorIdle: boolean) {
  const base = {
    actorIdle,
    artifactFresh: false,
    verdict: null as VerdictResult | null,
    prNumber: task.pr,
    headSha: null as string | null,
    merged: false,
    mergedAtMs: undefined as number | undefined,
    issueClosed: false,
    closedAtMs: undefined as number | undefined,
    filesClear: false,
    ciBucket: task.ci,
    maxPasses: deps.maxPasses,
  }

  switch (task.phase) {
    case 'implement': {
      const pr = task.pr ?? (await deps.prForBranch(task.branch))
      if (pr === null) return base
      // Persist on discovery, not on the phase transition: otherwise every tick
      // re-queries gh for a PR we already know about.
      task.pr = pr
      const view = await deps.prView(pr)
      return { ...base, prNumber: pr, headSha: view?.headSha ?? null }
    }
    case 'research':
    case 'spec':
    case 'plan': {
      delete task.artifact_missing
      if (!actorIdle) return base
      const absolute = absoluteArtifactPath(run, task)
      if (absolute === null) return base

      if (await isFresh(absolute, task.phase_entered_at)) {
        if (!(await isSettled(absolute, deps.fileSettleMs))) return base
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

      const claimed = new Set(
        [task.artifacts.research, task.artifacts.spec, task.artifacts.plan]
          .filter((path): path is string => path !== null),
      )
      const candidates = await adoptableArtifacts(checkout, claimed)
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
      return { ...base, artifactFresh: true }
    }
    case 'spec-review':
    case 'plan-review':
    case 'pr-review-intent':
    case 'pr-review-quality': {
      const verdict = await deps.verdictFor(run, task)
      return { ...base, artifactFresh: verdict !== null, verdict }
    }
    case 'merge': {
      if (task.pr === null) return base
      const view = await deps.prView(task.pr)
      return { ...base, merged: view?.merged ?? false, mergedAtMs: view?.mergedAtMs ?? undefined }
    }
    case 'close': {
      const view = await deps.issueView(task.issue)
      return { ...base, issueClosed: view?.closed ?? false, closedAtMs: view?.closedAtMs ?? undefined }
    }
    // Recomputed here rather than snapshotted before the loop: a row that holds
    // no files can enter one that does mid-tick (a design row escalating, say),
    // and a snapshot taken before that would release an overlapping sibling onto
    // files now in flight.
    case 'blocked-on-files':
      await widenFromPlan(run, task)
      return {
        ...base,
        filesClear: releasableFromFiles(run.tasks).some((t) => t.task_id === task.task_id),
      }
    case 'ci':
      return base
    default:
      return null
  }
}

export interface AnswerDeps {
  pluginRoot: string
  promptRetryMax: number
  send: (paneId: string, text: string) => Promise<{ ok: boolean; code?: string }>
  /** Collects what this tick did outside the ledger; see `saveOrReapply`. */
  effects?: RunEffect[]
}

export function markAnswerDelivered(
  run: Run, taskId: string, decisionId: string, resumeTo: TaskPhase,
): void {
  const task = run.tasks.find((t) => t.task_id === taskId)
  if (task?.phase !== 'blocked-on-decision' || task.pending_answer !== decisionId) return
  task.pending_answer = null
  task.delivery_attempts = 0
  // No prompt is rendered here, deliberately: `answer.md` has already been sent,
  // and rendering the row's own prompt would reserve a second verdict path and
  // move the file the agent was told to write. A resume is not a new review.
  enterTaskPhase(run, task, resumeTo, `decision ${decisionId} answered`)
  task.decision_from = null
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
    })

    const result = await deps.send(task.pane_id, text)
    if (!result.ok) {
      task.delivery_attempts += 1
      continue
    }

    const taskId = task.task_id
    const decisionId = decision.id
    markAnswerDelivered(run, taskId, decisionId, resumeTo)
    deps.effects?.push((fresh) => markAnswerDelivered(fresh, taskId, decisionId, resumeTo))
  }
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
      task_id: task.task_id, decision_id: decision.id,
      phase: task.decision_from ?? '', question: decision.question,
      recommendation: decision.recommendation,
      branch: task.branch, issue: String(task.issue),
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
