import type { RunPhase, TaskPhase } from './phases'

export type SessionKey = string

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type { RunPhase, TaskPhase } from './phases'

export type Verdict = 'CLEAR' | 'BLOCKER'

export type CiBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | 'unknown'

export type EventKind =
  | 'worktree.created' | 'worktree.removed'
  | 'pane.agent_detected' | 'pane.agent_status_changed' | 'pane.exited'

export interface QueuedEvent {
  kind: EventKind
  session: SessionKey
  at: number
  workspace_id?: string
  pane_id?: string
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
 * Stall-ladder state for ONE phase entry of ONE record. Absent, or stamped with
 * an `at`/`run_at` that no longer match, reads as zero — so any code that
 * re-stamps `phase_entered_at` re-arms the ladder without knowing it exists.
 */
export interface StallState {
  /** The record's `phase_entered_at` this state belongs to. */
  at: number
  /** The run's `phase_entered_at` this state belongs to. */
  run_at: number
  /** When the last rung was climbed — a sent probe or a deferral. The due anchor. */
  last_probe_at: number
  probes: number
  holds: number
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
  /** True when the issue was already closed at `merge` completion. */
  issue_closed_at_entry: boolean
  passes: Partial<Record<TaskPhase, number>>
  decisions: Decision[]
  decision_from: TaskPhase | null
  pending_answer: string | null
  delivery_attempts: number
  stall?: StallState
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
  intake_closed: boolean
  passes: Partial<Record<RunPhase, number>>
  stall?: StallState
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
