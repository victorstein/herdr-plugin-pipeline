import { join } from 'node:path'
import { gateStatus, releasableFromFiles } from '../lib/gating'
import type { IssueView, PrView } from '../lib/gh'
import { advanceTask, counterFor, enterTaskPhase } from '../lib/machine'
import { taskRow } from '../lib/phases'
import type { VerdictResult } from '../lib/predicates'
import { renderPrompt } from '../lib/render'
import { renderWorkerPrompt } from '../lib/worker-prompt'
import type { Run, Task, TaskPhase } from '../lib/types'
import { artifactPathFor } from './deliver'
import { runTeardown } from './teardown'

export interface TaskDeps {
  pluginRoot: string
  /**
   * Live `herdr agent status` read on a pane, already double-checked after
   * ACTOR_SETTLE_MS by the caller. NOT task.agent_status, which is the badge and
   * wake cache and can be stale by a whole turn.
   */
  liveIdle: (paneId: string) => Promise<boolean>
  maxPasses: number
  prForBranch: (branch: string) => Promise<number | null>
  prView: (pr: number) => Promise<PrView | null>
  issueView: (issue: number) => Promise<IssueView | null>
  verdictFor: (run: Run, task: Task) => Promise<VerdictResult | null>
  removeWorktree: (workspaceId: string) => Promise<boolean>
  /** Rendered detail of the failing checks, for the ci-red prompt. */
  ciDetail: (pr: number | null) => Promise<string>
}

/**
 * The task-level counterpart to deliver.ts's promptForRunPhase. Without it the
 * state machine advances once an artifact exists but nothing ever asks the
 * orchestrator to produce one, so every task phase stalls.
 */
export async function promptForTaskPhase(
  run: Run, task: Task, deps: TaskDeps, cameFrom: TaskPhase,
): Promise<string> {
  const common = {
    run_id: run.run_id,
    branch: task.branch,
    issue: String(task.issue),
    pr: task.pr === null ? 'unknown' : String(task.pr),
    pass: String(counterFor(task, task.phase)),
    verdict_path: join(run.repo_root, artifactPathFor(run, task) ?? ''),
  }

  switch (task.phase) {
    case 'pr-review-intent':
      return renderPrompt(deps.pluginRoot, 'pr-review-intent', common)
    case 'pr-review-quality':
      return renderPrompt(deps.pluginRoot, 'pr-review-quality', common)
    case 'merge':
      return renderPrompt(deps.pluginRoot, 'merge', common)
    case 'close':
      return task.issue_closed_at_entry ? '' : renderPrompt(deps.pluginRoot, 'close', common)
    case 'implement':
      // Re-entry from a red CI needs the failing checks; re-entry from a BLOCKER
      // review does not, because the review file already says what to fix.
      return cameFrom === 'ci'
        ? renderPrompt(deps.pluginRoot, 'ci-red', {
            ...common, ci_failure: await deps.ciDetail(task.pr),
          })
        : ''
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
  await runTeardown([run], deps.removeWorktree)

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
        text: `Dispatch ${task.task_id} (${task.branch}, #${task.issue}):\n\n` +
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
