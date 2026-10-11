import { join } from 'node:path'
import { IMPLEMENT_MODEL, REVIEW_EFFORT, WORKER_EFFORT } from './models'
import { nextPhase, taskRow, TIERS, tierOf } from './phases'
import type { Run, Task, TaskPhase, Tier } from './types'

// The worker's part of the loop ends where CI takes over: every row past it is the
// orchestrator's or the supervisor's.
const LOOP_END: TaskPhase = 'ci'

function loopStep(phase: TaskPhase, task: Task): string {
  switch (phase) {
    case 'research': return `\`research\` → \`${task.artifacts.research ?? ''}\``
    case 'spec': return `\`spec\` → \`${task.artifacts.spec ?? ''}\``
    case 'spec-review': return '`spec-review` — you dispatch the reviewer'
    case 'plan': return `\`plan\` → \`${task.artifacts.plan ?? ''}\``
    case 'plan-review': return '`plan-review` — you dispatch the reviewer again'
    case 'implement': return '`implement` — a subagent writes the code and tests; you verify, push and open the PR'
    case 'pr-review': return '`pr-review` — one review of the PR, intent then quality'
    case 'pr-review-intent': return '`pr-review-intent` — does the PR do what was asked'
    case 'pr-review-quality': return '`pr-review-quality` — is it written the way this codebase is'
    default: return `\`${phase}\``
  }
}

/**
 * The paths are written in as text, not as `{{research_path}}`: `render()` makes
 * one pass, so a token inside a variable's value would reach the worker verbatim.
 */
export function phaseLoop(task: Task): string {
  const tier = tierOf(task)
  const steps: string[] = []
  let phase = taskRow('queued').onClear as TaskPhase
  while (phase !== LOOP_END) {
    const row = taskRow(phase)
    if (row.actor === 'worker') steps.push(`${steps.length + 1}. ${loopStep(phase, task)}`)
    phase = nextPhase(tier, row)
  }
  return steps.join('\n')
}

// `verdict_seq` counts reservations, not finished reviews: a rewind onto the row
// reserves one, so after a rewind away before the review ran this over-claims.
const reviewRan = (task: Task, phase: TaskPhase): boolean => (task.verdict_seq?.[phase] ?? 0) > 0

/**
 * Spread into every task render site, so no path can render a prompt missing one
 * of these tokens. The review wording follows which reviews actually ran, not the
 * current tier: a light task raised to standard after skipping `plan-review`
 * still has an unreviewed plan.
 */
export function tierPromptVars(task: Task): Record<string, string> {
  const planReviewed = reviewRan(task, 'plan-review')
  return {
    tier: tierOf(task),
    task_id: task.task_id,
    agent_file: join('.claude', 'agents', `${task.surface}-dev.md`),
    implement_model: IMPLEMENT_MODEL,
    review_effort: REVIEW_EFFORT[tierOf(task)],
    phase_loop: phaseLoop(task),
    plan_status: planReviewed
      ? 'cleared review'
      : 'was not reviewed — read it critically, and fix it first if it is wrong',
    review_count: reviewRan(task, 'pr-review-quality') ? 'Both review stages cleared' : 'Review cleared',
    plan_review_note: planReviewed ? '' : 'No plan review ran; judge the plan\'s soundness from the diff as well.',
  }
}

export function taskTiers(run: Run): string {
  if (run.tasks.length === 0) return 'none'
  return run.tasks.map((task) => `${task.task_id} ${tierOf(task)}`).join(', ')
}

/** The whole-branch review reads every task's work, so it runs at the heaviest task's review effort. */
export function branchReviewEffort(run: Run): string {
  const tiers = run.tasks.map(tierOf)
  const heaviest = [...TIERS].reverse().find((tier) => tiers.includes(tier)) ?? 'light'
  return REVIEW_EFFORT[heaviest]
}

/**
 * The worker's effort is set by the dispatch block, from the tier at the time; the
 * worktree binds just before `agent start`, so the tier in force at adoption is the
 * one it started with. A task not yet adopted will start at its current tier.
 */
function startedTier(task: Task): Tier {
  const adoptedAt = task.adopted_at
  if (adoptedAt === null) return tierOf(task)
  return (task.tier_history ?? []).findLast((change) => change.at <= adoptedAt)?.to ?? tierOf(task)
}

export function effortSummary(task: Task): string {
  const started = startedTier(task)
  const worker = started === tierOf(task)
    ? `worker ${WORKER_EFFORT[started]}`
    : `worker ${WORKER_EFFORT[started]} (started ${started}; a tier change does not restart it)`
  return `${worker}, reviews ${REVIEW_EFFORT[tierOf(task)]}`
}
