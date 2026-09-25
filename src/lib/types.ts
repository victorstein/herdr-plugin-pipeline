import type { RunPhase, TaskPhase } from './phases'

export type SessionKey = string

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type { RunPhase, TaskPhase } from './phases'

export type Verdict = 'CLEAR' | 'BLOCKER'

export type CiBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | 'unknown'

export type EventKind =
  | 'worktree.created' | 'worktree.opened' | 'worktree.removed'
  | 'pane.agent_detected' | 'pane.agent_status_changed' | 'pane.exited' | 'pane.closed'
  | 'pane.moved'

export interface QueuedEvent {
  kind: EventKind
  session: SessionKey
  at: number
  workspace_id?: string
  pane_id?: string
  /** `pane.moved` only: the id the pane had before herdr renamed it. */
  previous_pane_id?: string
  agent_status?: AgentStatus
  released?: boolean
  branch?: string
  checkout_path?: string
  repo_key?: string
  repo_root?: string
  is_linked_worktree?: boolean
}

export interface Decision {
  id: string
  asked_at: number
  from_phase: TaskPhase
  question: string
  recommendation: string
  answer: string | null
  answered_by: 'orchestrator' | 'human' | 'abandoned' | null
  answered_at: number | null
  prompted_at: number | null
}

/**
 * An idle worker's artifact row with nothing at the recorded path and no single
 * file the adoption scan could take instead. Keyed like `StallState`, so a phase
 * re-entry retires it without anyone clearing it.
 */
export interface MissingArtifact {
  /** The task's `phase_entered_at` this record belongs to. */
  at: number
  path: string
  /** What the adoption scan found: nothing, or two or more files it would not choose between. */
  candidates: string[]
}

/**
 * Stall-ladder state for ONE phase entry of ONE record. Absent, or stamped with
 * an `at`/`run_at` that no longer match, reads as zero — so any code that
 * re-stamps `phase_entered_at` re-arms the ladder without knowing it exists.
 */
export interface StallState {
  /** The record's `phase_entered_at` this state belongs to. */
  at: number
  /** The run's `phase_entered_at` this state belongs to. */
  run_at: number
  /**
   * When the last rung was climbed — a delivered probe, a deferral, or an
   * undelivered rung, which is back-dated to the start of its failure streak.
   * The due anchor.
   */
  last_probe_at: number
  /** Probe rungs climbed, INCLUDING undelivered ones — an unreachable pane must still escalate. */
  probes: number
  /** How many of `probes` never reached the pane. Optional: ledgers written before #32 lack it. */
  undelivered?: number
  /** Start of the current run of failed sends; cleared by a delivered probe. */
  undeliverable_since?: number
  holds: number
}

/**
 * What `git status` showed in an idle worker's checkout during a code row. Keyed
 * like `StallState`, so a phase re-entry retires it without anyone clearing it.
 * `count: 0` records a clean or unreadable check, so an idle worker is inspected
 * once per idle spell rather than once per tick.
 */
export interface UncommittedWork {
  /** The task's `phase_entered_at` this record belongs to. */
  at: number
  count: number
  /** The first few porcelain paths, for the operator; `count` is the real size. */
  sample: string[]
}

/**
 * A rendered prompt the supervisor still owes a pane. Written before the send and
 * removed once herdr confirms the agent took it up, so a prompt that fails to land
 * is re-sent on a later tick instead of lost with the tick that produced it.
 */
export interface OutboxEntry {
  id: string
  /**
   * Addressed by role, not pane id: a rebound orchestrator or a re-dispatched
   * worker is the same recipient under a new pane.
   */
  to: 'orchestrator' | 'worker'
  /** `null` for a run-level prompt. */
  task_id: string | null
  /**
   * The record's `phase_entered_at` when the prompt was written. A record that has
   * since moved phase has been sent that phase's own prompt, so this one is stale.
   */
  entered_at: number
  text: string
  /** The digest header's transition, kept so a late delivery still says why it came. */
  phase_note?: string
  queued_at: number
  /** Sends herdr answered with a failure; a held send is not an attempt. */
  attempts: number
  last_code?: string
  last_attempt_at?: number
}

export interface Task {
  task_id: string
  branch: string
  issue: number
  surface: string
  depends_on: string[]
  files: string[]
  keep_worktree: boolean
  workspace_id: string | null
  pane_id: string | null
  /**
   * The pane a dead worker last ran in, kept for `herdr pane read` once
   * `pane_id` is cleared. Optional: ledgers written before #12 lack it.
   */
  last_pane_id?: string
  agent_status: AgentStatus
  phase: TaskPhase
  phase_entered_at: number
  escalated_from: TaskPhase | null
  head_sha_at_entry: string | null
  pr: number | null
  ci: CiBucket | null
  /** Worktree checkout path. Task artifacts resolve against this, not repo_root. */
  checkout_path: string | null
  artifacts: {
    research: string | null
    spec: string | null
    plan: string | null
    verdicts: Record<string, string>
  }
  registered_at: number
  adopted_at: number | null
  merged_at_ms: number | null
  /**
   * The merge's commit on the base branch, which a dependent's dispatch base must
   * contain. Optional because runs written before it existed lack it.
   */
  merge_commit?: string | null
  /** True when the issue was already closed at `merge` completion. */
  issue_closed_at_entry: boolean
  passes: Partial<Record<TaskPhase, number>>
  /**
   * Reviews commissioned per phase, and therefore the key of the current one.
   * Only `reserveVerdict` advances it — never a transition, a resume, or a
   * rewind's counter reset — which is what keeps a live agent's path stable.
   */
  verdict_seq?: Partial<Record<TaskPhase, number>>
  decisions: Decision[]
  decision_from: TaskPhase | null
  pending_answer: string | null
  delivery_attempts: number
  stall?: StallState
  /** Optional: ledgers written before #23 lack it. */
  artifact_missing?: MissingArtifact
  /** Optional: ledgers written before #14 lack it. */
  uncommitted_work?: UncommittedWork
  /**
   * Set when the gate opens and cleared once the worker has the brief. Marks the
   * pending state rather than stamping the briefed one so that a ledger written
   * before #89, which lacks it, reads as already briefed.
   */
  awaiting_brief?: true
  notes: string
}

export interface RunArtifacts {
  verdicts: Record<string, string>
}

export interface Run {
  run_id: string
  session: SessionKey
  socket_path: string
  repo_key: string
  repo_root: string
  title: string
  phase: RunPhase
  phase_entered_at: number
  escalated_from: RunPhase | null
  orchestrator_pane: string | null
  artifacts: RunArtifacts
  tasks: Task[]
  history: HistoryEntry[]
  schema_version: number
  /**
   * Bumped by every save and checked against disk before it. Absent on runs
   * written before it existed, which read as 0 — so no schema bump.
   */
  revision?: number
  intake_closed: boolean
  passes: Partial<Record<RunPhase, number>>
  /** Per-phase review count; see the note on `Task.verdict_seq`. */
  verdict_seq?: Partial<Record<RunPhase, number>>
  stall?: StallState
  /** Optional: ledgers written before #24 lack it, which reads as empty. */
  outbox?: OutboxEntry[]
}

export interface HistoryEntry {
  at: number
  task_id?: string
  from: string
  to: string
  why: string
}

export interface Orchestrator {
  pane_id: string
  workspace_id: string
  socket_path: string
  claimed_at: number
}

export interface SupervisorPid {
  pid: number
  pane_pid: number
  started_at_ms: number
  session: SessionKey
  socket_path: string
  pane_id: string
}
