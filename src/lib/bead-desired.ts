import { sha8 } from './batch'
import { BD_ACTOR } from './bd'
import { fromDecision, heldForTheHuman } from './before-merge'
import { escalatedUnanswered } from './decisions'
import { fileHolders, TERMINAL_BAD } from './gating'
import { phaseHoldsBead } from './held'
import { wasAborted } from './ledger'
import { rowRunsIn, type RunMode, TASK_ROWS } from './phases'
import type { Resolution, Run, Task } from './types'

/**
 * A metadata key, not a label: bd sorts labels, and a long `hpipe:run=…` label
 * pushed the phase label off the end of every bv card.
 */
export const RUN_METADATA_KEY = 'hpipe.run'
export const ABORTED_LABEL = 'aborted'
/**
 * Phase labels are bare phase names because a bv card is ~22 characters wide and
 * truncated `phase:research` to `phase:re`. Earlier builds wrote the prefixed form;
 * keeping it managed lets the reconciler strip it from their beads.
 */
const LEGACY_PHASE_LABEL_PREFIX = 'phase:'
/**
 * Per mode, because a bare phase name can be an ordinary word: a per-task run never
 * enters `sync`, and stripping a human's `sync` label from every bead it claims
 * would take something it never wrote.
 */
const phaseLabelsIn = (mode: RunMode): ReadonlySet<string> =>
  new Set([...TASK_ROWS.filter((row) => rowRunsIn(row, mode)).map((row) => row.phase), ABORTED_LABEL])
const PHASE_LABELS: Readonly<Record<RunMode, ReadonlySet<string>>> = {
  'per-task': phaseLabelsIn('per-task'),
  'single-pr': phaseLabelsIn('single-pr'),
}
export const AWAITING_HUMAN_LABEL = 'hpipe:awaiting-human'
/**
 * Provenance labels sit outside the managed namespaces on purpose: a discovered bead can later be
 * adopted with `hpipe task --bead`, and the reconciler strips managed labels no task desires.
 */
export const DISCOVERED_LABEL = 'discovered'
export const discoveryLabel = (runId: string, taskId: string, discoveryId: string): string =>
  `discovery:${runId}:${taskId}:${discoveryId}`
const MANAGED_LABEL_PREFIXES: readonly string[] = ['hpipe:', LEGACY_PHASE_LABEL_PREFIX]

/** `hpipe status` and the close stall both speak up from here, so the two never disagree. */
export const BEAD_SYNC_ALERT_FAILURES = 5

export type BeadStatus = 'open' | 'in_progress' | 'blocked' | 'closed'

export interface DesiredComment {
  marker: string
  text: string
  /**
   * Posted only while the bead is open. A single-PR task's bead closes at landing,
   * long before the human rules at the batch PR, and the run's record covers it from there.
   */
  whileOpen?: true
}

export interface DesiredBead {
  bead: string
  status: BeadStatus
  /** Null is unassigned. */
  assignee: string | null
  labels: string[]
  metadata: Record<string, string>
  blockedBy: string[]
  /**
   * The run's other beads this one must not be blocked by. Only a file wait adds
   * an edge that later has to go, so only these are ever removed: an edge a human
   * drew to a bead outside the run is theirs.
   */
  unblockedBy: string[]
  comments: DesiredComment[]
}

/** Every other label is a human's, and the reconciler never removes it. */
export const isManagedLabel = (label: string, mode: RunMode): boolean =>
  PHASE_LABELS[mode].has(label) || MANAGED_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))

/**
 * Keyed by a decision (`asked`, `ruling`), or by a before-merge check: `before-merge`,
 * then `r1`, `r2`, … per ruling.
 */
export function commentMarker(
  taskId: string, recordId: string, kind: 'asked' | 'ruling' | 'before-merge' | `r${number}`,
): string {
  return `[hpipe ${taskId}/${recordId}/${kind}]`
}

export function beadOutOfSync(task: Task): boolean {
  return task.bead_sync.streak >= BEAD_SYNC_ALERT_FAILURES && task.bead_sync.last_error !== null
}

function dependencyBeads(task: Task, run: Run): string[] {
  return task.depends_on
    .map((id) => run.tasks.find((t) => t.task_id === id)?.bead)
    .filter((bead): bead is string => bead !== undefined)
}

/**
 * A wait on a sibling's files is a block by that sibling's bead, so bv shows the
 * card under BLOCKED and names the task it waits on. berean-os kept three such
 * waits under IN PROGRESS, saying nothing about whom. Measured on a live run.
 */
function blockerBeads(task: Task, run: Run): string[] {
  const holders = task.phase === 'blocked-on-files' ? fileHolders(task, run.tasks).map((t) => t.bead) : []
  return [...new Set([...dependencyBeads(task, run), ...holders])]
}

function taskComments(task: Task): DesiredComment[] {
  return [...decisionComments(task), ...checkComments(task)]
}

function rulingText(ruling: Resolution): string {
  const on = ruling.head === null ? '' : ` on ${sha8(ruling.head)}`
  switch (ruling.as) {
    case 'confirmed': return `Confirmed by the human${on}`
    case 'waived': return `Waived by the human: ${ruling.note ?? ''}`
    case 'failed': return `Failed${on}: ${ruling.note ?? ''}`
  }
}

function checkComments(task: Task): DesiredComment[] {
  return (task.before_merge ?? []).flatMap((check) => {
    const recorded = commentMarker(task.task_id, check.id, 'before-merge')
    return [
      {
        marker: recorded, whileOpen: true as const,
        text: [`Before merge, the human checks: ${check.check}${fromDecision(check)}`, '', recorded].join('\n'),
      },
      ...check.resolutions.map((ruling, i) => {
        const marker = commentMarker(task.task_id, check.id, `r${i + 1}`)
        return { marker, whileOpen: true as const, text: [rulingText(ruling), '', marker].join('\n') }
      }),
    ]
  })
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
  const phaseLabel: string = task.phase
  const blockedBy = blockerBeads(task, run)
  const unblockedBy = run.tasks
    .filter((t) => t.task_id !== task.task_id && !blockedBy.includes(t.bead))
    .map((t) => t.bead)
  const shared = {
    bead: task.bead, metadata: { [RUN_METADATA_KEY]: run.run_id },
    blockedBy, unblockedBy, comments: taskComments(task),
  }

  // A merge made while the human still owes a check is recorded, but the bead waits
  // for their ruling as an escalated decision does, rather than closing on the merge.
  if (heldForTheHuman(run, task)) {
    return { ...shared, status: 'blocked', assignee: BD_ACTOR, labels: [phaseLabel, AWAITING_HUMAN_LABEL] }
  }
  if (task.merged_at_ms !== null) {
    return { ...shared, status: 'closed', assignee: BD_ACTOR, labels: [] }
  }
  if (!phaseHoldsBead(run.phase, task.phase)) {
    const why = wasAborted(run) && !TERMINAL_BAD.has(task.phase) ? ABORTED_LABEL : phaseLabel
    return { ...shared, status: 'open', assignee: null, labels: [why] }
  }
  if (escalatedUnanswered(task) !== null || task.phase === 'escalated') {
    return { ...shared, status: 'blocked', assignee: BD_ACTOR, labels: [phaseLabel, AWAITING_HUMAN_LABEL] }
  }
  if (task.phase === 'blocked-on-files') {
    return { ...shared, status: 'blocked', assignee: BD_ACTOR, labels: [phaseLabel] }
  }
  if (task.phase !== 'queued' && task.awaiting_brief !== true) {
    return { ...shared, status: 'in_progress', assignee: BD_ACTOR, labels: [phaseLabel] }
  }
  return { ...shared, status: 'open', assignee: null, labels: [phaseLabel] }
}
