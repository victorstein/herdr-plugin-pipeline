import { join } from 'node:path'
import { IMPLEMENT_MODEL } from './models'
import { nextPhase, taskRow, tierOf } from './phases'
import type { Run, Task, TaskPhase } from './types'

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
