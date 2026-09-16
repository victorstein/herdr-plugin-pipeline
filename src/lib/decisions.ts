import type { Decision, Task, TaskPhase } from './types'

export function openDecisionFor(task: Task): Decision | null {
  return task.decisions.find((d) => d.answer === null && d.answered_by === null) ?? null
}

export function openDecision(
  task: Task, input: { question: string; recommendation: string },
): Decision {
  const decision: Decision = {
    id: `d${task.decisions.length + 1}`,
    asked_at: Date.now(),
    from_phase: task.phase as TaskPhase,
    question: input.question,
    recommendation: input.recommendation,
    answer: null, answered_by: null, answered_at: null, prompted_at: null,
  }
  task.decisions.push(decision)
  return decision
}

export function answerDecision(
  task: Task, id: string, answer: string, by: 'orchestrator' | 'human',
): Decision {
  const decision = task.decisions.find((d) => d.id === id)
  if (!decision) throw new Error(`no such decision: ${id}`)
  decision.answer = answer
  decision.answered_by = by
  decision.answered_at = Date.now()
  return decision
}

/**
 * A pane death ends every question addressed to it — including one already
 * answered but never delivered, which would otherwise outlive its task in
 * `hpipe status` and keep the stall probe nagging.
 */
export function abandonDecisions(task: Task): void {
  for (const d of task.decisions) {
    if (d.answered_by === 'abandoned') continue
    if (d.answer !== null && task.pending_answer !== d.id) continue
    d.answered_by = 'abandoned'
    d.answered_at = Date.now()
  }
  task.pending_answer = null
}
