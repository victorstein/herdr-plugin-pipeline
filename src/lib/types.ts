import type { RunPhase, TaskPhase, Tier } from './phases'

export type SessionKey = string

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type { RunMode, RunPhase, TaskPhase, Tier } from './phases'

export type Verdict = 'CLEAR' | 'BLOCKER'

export type CiBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | 'unknown'

export type EventKind =
  | 'worktree.created' | 'worktree.opened' | 'worktree.removed'
  | 'pane.agent_detected' | 'pane.agent_status_changed' | 'pane.exited' | 'pane.closed'
  | 'pane.moved' | 'workspace.closed'
  /** Written by `hpipe nudge`, not herdr: release the supervisor's usage-limit hold on `pane_id`. */
  | 'pipeline.nudge'

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
  /** Set by `hpipe escalate` when the question goes to the human; the bead shows blocked until it is answered. */
  escalated_at: number | null
  /** What the orchestrator recommended when it escalated, posted on the bead beside the worker's. */
  orchestrator_recommendation: string | null
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
  /**
   * `resume`: carry on where Claude's usage limit stopped the worker. `carry-on`:
   * `hpipe nudge` telling a worker that stopped with uncommitted work to finish it.
   * Absent: the phase's own prompt, which a worker that has not read it cannot
   * have answered.
   */
  kind?: 'resume' | 'carry-on'
  /** The digest header's transition, kept so a late delivery still says why it came. */
  phase_note?: string
  queued_at: number
  /** Sends herdr answered with a failure; a held send is not an attempt. */
  attempts: number
  last_code?: string
  last_attempt_at?: number
}

/** The worker's brief for the life of the run: captured at registration, never re-read from the bead. */
export interface BeadBrief {
  title: string
  description: string
  acceptance: string
  labels: string[]
  captured_at_ms: number
}

/** `failures` is monotone; a converged write clears `last_error` and resets `streak`. */
export interface BeadSync {
  failures: number
  /** Failures since the last converged write: what "out of sync" is judged on. */
  streak: number
  last_error: string | null
  last_ok_at_ms: number | null
}

/** Out-of-scope work a worker recorded with `hpipe discover`, filed as a bead only by the orchestrator. */
export interface Discovery {
  id: string
  title: string
  body_path: string
  filed_bead: string | null
}

/** What `.claude/pipeline-check` said: `none` when the repo declares no check. */
export type CheckOutcome = 'passed' | 'none'

/**
 * What `hpipe submit` recorded: the single-PR worker's equivalent of opening a PR.
 * Kept across every rewind — an edge reads only one recorded at or after its
 * phase entry, so a stale one can never clear anything.
 */
export interface Submission {
  kind: 'implement' | 'sync'
  /** The conventional title this task's change ships under in the batch PR. */
  title: string
  head_sha: string
  at: number
  check: CheckOutcome
  /** `sync` only: whether every commit since `land_sha` is an automatic merge of the batch. */
  merge?: 'clean' | 'dirty'
  /** `sync` only, when dirty: the first commit the walk could not account for. */
  dirty_at?: string
}

/**
 * Why a task's last `implement` exit went past its PR review. It describes only
 * that exit: entering `implement` or any review row clears it.
 */
export interface ReviewSkip {
  at: number
  /** The PR review rows the route would have run. */
  skipped: TaskPhase[]
  /** Lines the change adds outside `docs/`, from `git diff --numstat` against its base. */
  added_lines: number
  /** The design reviews on the route, every one cleared on its first pass. */
  cleared: TaskPhase[]
}

/** One landing on the batch branch, and so one line of the batch PR's release notes. */
export interface Landing {
  title: string
  land_sha: string
  at: number
  /**
   * The PR review rows this landing went in past. Kept here because `review_skip`
   * is cleared once a later commit is reviewed, and with it any record that this
   * landing never was. Absent on a reviewed landing and on older ledgers.
   */
  review_skipped?: TaskPhase[]
}

export interface Task {
  task_id: string
  branch: string
  bead: string
  brief: BeadBrief
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
  /** The head `ci` was read for, and when that head was first seen; a merge on any other head is unchecked. */
  ci_head?: { sha: string; seen_at: number }
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
  /**
   * Set only by a reconciler pass that saw the bead closed after `merged_at_ms`
   * was recorded, and cleared with the merge by a rewind: the close row's edge.
   */
  bead_closed_at_ms: number | null
  bead_sync: BeadSync
  discoveries: Discovery[]
  passes: Partial<Record<TaskPhase, number>>
  /**
   * Reviews commissioned per phase, and therefore the key of the current one.
   * Only `reserveVerdict` advances it — never a transition, a resume, or a
   * rewind's counter reset — which is what keeps a live agent's path stable.
   */
  verdict_seq?: Partial<Record<TaskPhase, number>>
  decisions: Decision[]
  decision_from: TaskPhase | null
  /**
   * The entry of the phase a decision was asked from, kept across the round trip
   * so an artifact written before asking still counts; see `artifactFreshAfter`.
   * Optional: absent outside a decision, and on ledgers written before #115.
   */
  artifact_fresh_after?: number
  /**
   * When the pending answer was sent. Its delivery is confirmed on later ticks,
   * once the worker's input box no longer holds it. Optional, like the next field:
   * absent outside a decision, and on ledgers written before #117.
   */
  answer_sent_at?: number
  /** The worker was seen working after its answer was sent; `artifactFreshAfter` needs it. */
  worked_on_answer?: true
  pending_answer: string | null
  delivery_attempts: number
  stall?: StallState
  /** Optional: ledgers written before #23 lack it. */
  artifact_missing?: MissingArtifact
  /** Optional: ledgers written before #14 lack it. */
  uncommitted_work?: UncommittedWork
  /**
   * The `phase_entered_at` of a `blocked-on-files` stay in which a tick held the
   * task back, so the gate's exit can tell a wait from a pass-through. Keyed like
   * `StallState`, so a re-entry retires it without anyone clearing it.
   */
  files_waited_at?: number
  /**
   * Set when the gate opens and cleared once the worker has the brief. Marks the
   * pending state rather than stamping the briefed one so that a ledger written
   * before #89, which lacks it, reads as already briefed.
   */
  awaiting_brief?: true
  /** Read it through `tierOf`. Optional: ledgers written before tiers lack it, and read as `heavy`. */
  tier?: Tier
  /** Every tier this task has had, registration first. */
  tier_history?: TierChange[]
  /** Single-PR only. */
  submission?: Submission
  /**
   * Single-PR only: the reviewed head that lands, recorded when the last review
   * clears and advanced only by a clean sync. Never re-read from the branch.
   */
  land_sha?: string | null
  /** Single-PR only, append-only: no rewind clears it, because no rewind takes work off the batch branch. */
  landed?: Landing[]
  /** Absent unless the last `implement` exit skipped the PR review; older ledgers never carry it. */
  review_skip?: ReviewSkip
  notes: string
}

export interface RunArtifacts {
  verdicts: Record<string, string>
}

/** The branch a single-PR run lands every task on, and the one PR it ships through. */
export interface Batch {
  branch: string
  /** The default branch at start: the final PR's base. */
  into: string
  base_commit: string
  /** Absolute: prompts render it, and the orchestrator's shell may not know the state dir. */
  checkout: string
  pr: number | null
  head_sha_at_entry: string | null
  ci: CiBucket | null
  /** The head `ci` was read for, and when that head was first seen. */
  ci_head?: { sha: string; seen_at: number }
  /** What `hpipe batch-check` last ran on; `ship` clears only once the PR's head is this one. */
  checked?: { head_sha: string; at: number; check: CheckOutcome }
  merged_at_ms: number | null
  merge_commit: string | null
  /** Set when a fetch of the batch branch fails, cleared by the next good one. */
  fetch_error?: { reason: string; since: number } | null
  /**
   * GitHub's answer at `start`: a ruleset refuses force-pushes and deletion on the
   * branch. Absent when it said no or could not say, so the advice is still given.
   */
  ruleset_protected?: true
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
  /** Present exactly when the run ships as one PR; see `modeOf`. */
  batch?: Batch
}

export interface HistoryEntry {
  at: number
  task_id?: string
  from: string
  to: string
  why: string
}

/**
 * Kept out of `run.history` on purpose: `enteredByRewind` reads a task's last
 * history entry to tell a rewound task from one never dispatched, and a tier
 * entry landing after a rewind would hide the rewind.
 */
export interface TierChange {
  at: number
  /** Null on the registration entry. */
  from: Tier | null
  to: Tier
  source: 'label' | 'flag' | 'default' | 'hpipe-tier'
  /** The caller's HERDR_PANE_ID; null when it was unset. */
  pane: string | null
  /** On a registration entry, the reason `hpipe task` printed on its `tier:` line. */
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
  /** The run schemas this supervisor drives. Absent on a supervisor that predates it, which drives only 3. */
  schemas?: number[]
}
