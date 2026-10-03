import { BD_ACTOR } from './bd'
import { escalatedUnanswered } from './decisions'
import { TERMINAL_BAD } from './gating'
import { phaseHoldsBead } from './held'
import { wasAborted } from './ledger'
import type { Run, Task } from './types'

/**
 * A metadata key, not a label: bd sorts labels, and a long `hpipe:run=…` label
 * pushed `phase:` off the end of every bv card.
 */
export const RUN_METADATA_KEY = 'hpipe.run'
export const PHASE_LABEL_PREFIX = 'phase:'
export const AWAITING_HUMAN_LABEL = 'hpipe:awaiting-human'
/**
 * Provenance labels sit outside the managed namespaces on purpose: a discovered bead can later be
 * adopted with `hpipe task --bead`, and the reconciler strips managed labels no task desires.
 */
export const DISCOVERED_LABEL = 'discovered'
export const discoveryLabel = (runId: string, taskId: string, discoveryId: string): string =>
  `discovery:${runId}:${taskId}:${discoveryId}`
const MANAGED_LABEL_PREFIXES: readonly string[] = ['hpipe:', PHASE_LABEL_PREFIX]

/** `hpipe status` and the close stall both speak up from here, so the two never disagree. */
export const BEAD_SYNC_ALERT_FAILURES = 5

export type BeadStatus = 'open' | 'in_progress' | 'blocked' | 'closed'

export interface DesiredComment {
  marker: string
  text: string
}

export interface DesiredBead {
  bead: string
  status: BeadStatus
  /** Null is unassigned. */
  assignee: string | null
  labels: string[]
  metadata: Record<string, string>
  blockedBy: string[]
  comments: DesiredComment[]
}

/** Labels outside these namespaces are a human's, and the reconciler never removes them. */
export const isManagedLabel = (label: string): boolean =>
  MANAGED_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))

export function commentMarker(taskId: string, decisionId: string, kind: 'asked' | 'ruling'): string {
  return `[hpipe ${taskId}/${decisionId}/${kind}]`
}

export function beadOutOfSync(task: Task): boolean {
  return task.bead_sync.streak >= BEAD_SYNC_ALERT_FAILURES && task.bead_sync.last_error !== null
}

function dependencyBeads(task: Task, run: Run): string[] {
  return task.depends_on
    .map((id) => run.tasks.find((t) => t.task_id === id)?.bead)
    .filter((bead): bead is string => bead !== undefined)
}

/** One per escalated question and one per ruling, each ending in the marker that makes posting it idempotent. */
function decisionComments(task: Task): DesiredComment[] {
  return task.decisions.flatMap((decision) => {
    const comments: DesiredComment[] = []
    if (decision.escalated_at !== null) {
      const marker = commentMarker(task.task_id, decision.id, 'asked')
      comments.push({
        marker,
        text: [
          `Question for the human (${task.task_id}, asked in ${decision.from_phase}):`, '', decision.question, '',
          'The worker recommends:', '', decision.recommendation, '',
          'The orchestrator recommends:', '', decision.orchestrator_recommendation ?? '(none given)', '',
          marker,
        ].join('\n'),
      })
    }
    const ruled = decision.answered_by === 'orchestrator' || decision.answered_by === 'human'
    if (ruled && decision.answer !== null) {
      const marker = commentMarker(task.task_id, decision.id, 'ruling')
      comments.push({
        marker,
        text: [`Ruling by the ${decision.answered_by} on ${task.task_id}/${decision.id}:`, '', decision.answer, '', marker].join('\n'),
      })
    }
    return comments
  })
}

/**
 * The first matching row of spec §5's table. The release row reads the held
 * predicate itself, so adoption, `hpipe next` and the release can never
 * disagree about whether a task still holds its bead.
 */
export function desiredBead(task: Task, run: Run): DesiredBead {
  const phaseLabel = `${PHASE_LABEL_PREFIX}${task.phase}`
  const shared = {
    bead: task.bead, metadata: { [RUN_METADATA_KEY]: run.run_id },
    blockedBy: dependencyBeads(task, run), comments: decisionComments(task),
  }

  if (task.merged_at_ms !== null) {
    return { ...shared, status: 'closed', assignee: BD_ACTOR, labels: [] }
  }
  if (!phaseHoldsBead(run.phase, task.phase)) {
    const why = wasAborted(run) && !TERMINAL_BAD.has(task.phase) ? `${PHASE_LABEL_PREFIX}aborted` : phaseLabel
    return { ...shared, status: 'open', assignee: null, labels: [why] }
  }
  if (escalatedUnanswered(task) !== null) {
    return { ...shared, status: 'blocked', assignee: BD_ACTOR, labels: [phaseLabel, AWAITING_HUMAN_LABEL] }
  }
  if (task.phase !== 'queued' && task.awaiting_brief !== true) {
    return { ...shared, status: 'in_progress', assignee: BD_ACTOR, labels: [phaseLabel] }
  }
  return { ...shared, status: 'open', assignee: null, labels: [phaseLabel] }
}
