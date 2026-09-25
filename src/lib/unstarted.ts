import { BOOTSTRAP_REL, type Bootstrap } from './bootstrap'
import { baseArgument, type DispatchBase } from './dispatch-base'
import { isCurrent } from './outbox'
import { runRow, taskRow } from './phases'
import type { Run, Task } from './types'

/**
 * A worker's pane is recorded only when herdr detects an agent in its worktree
 * or `dispatch --task` hands it the brief, and the dispatch flow runs the repo's
 * bootstrap between `worktree create` and `agent start` — so a bound worktree
 * with no pane is normal for about that long.
 */
export const UNSTARTED_GRACE_MS = 5 * 60_000

export interface UnstartedWorker {
  workspaceId: string
  /** When the worktree was bound; the phase entry for a record whose stamp a rewind cleared. */
  since: number
}

/**
 * A worker row whose worktree exists but in which no agent has been detected.
 * Nothing else notices one: with no pane the row's actor never reads idle, so
 * the phase cannot advance, and the digest called it "worker's move". The
 * berean-os run left `w23:p1` at a bare shell this way until the human spotted
 * it. Measured on a live run.
 */
export function unstartedWorker(run: Run, task: Task): UnstartedWorker | null {
  if (runRow(run.phase).releasesPane === true) return null
  if (taskRow(task.phase).actor !== 'worker') return null
  if (task.pane_id !== null || task.workspace_id === null) return null
  return { workspaceId: task.workspace_id, since: task.adopted_at ?? task.phase_entered_at }
}

export function overdueUnstartedWorker(run: Run, task: Task, now: number): UnstartedWorker | null {
  const unstarted = unstartedWorker(run, task)
  return unstarted !== null && now - unstarted.since >= UNSTARTED_GRACE_MS ? unstarted : null
}

export interface UnbriefedWorker {
  /** Null until an agent has been detected or recorded for the task. */
  paneId: string | null
}

/**
 * A worker row still owed its brief — before `agent start`, or in the gap
 * between it and `dispatch --task`. Either way the next move is the
 * orchestrator's, not the worker's.
 */
export function unbriefedWorker(run: Run, task: Task): UnbriefedWorker | null {
  if (runRow(run.phase).releasesPane === true) return null
  if (task.awaiting_brief !== true || task.phase !== taskRow('queued').onClear) return null
  return { paneId: task.pane_id }
}

export function briefCommand(task: Task, paneId: string | null, hpipe: string): string {
  return `\`${hpipe} dispatch --task ${task.task_id} --pane ${paneId ?? '<pane>'}\``
}

/**
 * A worker row with neither a worktree nor a pane. A task the gate has just opened
 * is one until the orchestrator's dispatch lands, so it is owed the same bootstrap
 * grace; a task a human rewound here after its worktree went — the live t3,
 * `pane.exited` → `failed` → `rewind … research` — has no dispatch under way and
 * is owed nothing. Measured on a live run.
 */
export function undispatchedWorker(run: Run, task: Task): { since: number } | null {
  if (runRow(run.phase).releasesPane === true) return null
  if (taskRow(task.phase).actor !== 'worker') return null
  if (task.pane_id !== null || task.workspace_id !== null) return null
  return { since: task.phase_entered_at }
}

function enteredByRewind(run: Run, task: Task): boolean {
  const entry = run.history.findLast((h) => h.task_id === task.task_id)
  return entry?.from === 'rewind' && entry.to === task.phase && entry.at >= task.phase_entered_at
}

export function overdueUndispatchedWorker(run: Run, task: Task, now: number): { since: number } | null {
  const undispatched = undispatchedWorker(run, task)
  if (undispatched === null) return null
  return enteredByRewind(run, task) || now - undispatched.since >= UNSTARTED_GRACE_MS ? undispatched : null
}

/** Printed for pasting into a shell, where a repo path with a space would split. */
function shellQuoted(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

/** Workers run unattended: a permission prompt would hold one with nobody watching its pane. */
function startAgentCommand(paneId: string): string {
  return `herdr agent start <name> --kind claude --pane ${paneId} -- --dangerously-skip-permissions`
}

const START_AGENT = `\`${startAgentCommand('<root pane>')}\``

const CREATED_ROOT_PANE = '<.result.root_pane.pane_id>'

/**
 * The whole dispatch, in order, for both paths that dispatch: `hpipe task` at
 * registration and the supervisor's prompt when a gate opens later. Most tasks
 * dispatch at registration, and that path once printed only the header lines,
 * so the orchestrator started its workers without the permissions flag, which
 * only the other path's prompt carried. Measured on a live run.
 */
export function dispatchSequence(
  run: Run, task: Task, base: DispatchBase, bootstrap: Bootstrap, hpipe: string,
): string {
  const steps = [
    `herdr worktree create --cwd ${shellQuoted(run.repo_root)} --branch ${task.branch} --base ${baseArgument(base)}`,
    ...(bootstrap.kind === 'none' ? [] : [`(cd "<.result.worktree.path>" && ./${BOOTSTRAP_REL})`]),
    startAgentCommand(CREATED_ROOT_PANE),
    `${hpipe} dispatch --task ${task.task_id} --pane ${CREATED_ROOT_PANE}`,
  ]
  return ['dispatch, in order:', ...steps.map((step) => `    ${step}`)].join('\n')
}

/**
 * Past the briefed phase, what a new agent is given once it is bound. A rewind
 * that found no worker queues the brief and the phase prompt as one entry, which
 * the courier sends as soon as herdr detects the agent — so that entry is the one
 * channel, and a hand-sent brief would only repeat it out of order.
 */
function handoffPastBrief(run: Run, task: Task, hpipe: string): string {
  const queued = (run.outbox ?? []).some((entry) =>
    entry.to === 'worker' && entry.task_id === task.task_id && isCurrent(run, entry))
  if (queued) {
    return `its brief and ${task.phase} prompt are already queued and are sent on their own once ` +
      'herdr detects the agent — send it nothing yourself'
  }
  return `hand it \`${hpipe} brief --task ${task.task_id}\` over \`herdr agent prompt\` and tell it ` +
    `the task is in ${task.phase}`
}

/**
 * Leads with `worktree open` once a checkout has been recorded: `forget` and a
 * closed workspace leave it on disk, `worktree create` then fails on the existing
 * path, and `open` emits `worktree.opened`, which binds by branch. `create` on a
 * branch that already exists checks it out rather than cutting a new one from the
 * base. Both measured on herdr 0.9.0.
 */
export function dispatchWorkerCommand(run: Run, task: Task, hpipe: string): string {
  const create = `\`herdr worktree create --cwd ${shellQuoted(run.repo_root)} --branch ${task.branch} --base <commit>\` ` +
    `(the commit on the \`base:\` line \`${hpipe} show --task ${task.task_id}\` prints, never a base you pick)`
  const open = `\`herdr worktree open --cwd ${shellQuoted(run.repo_root)} --branch ${task.branch}\``
  const worktree = task.checkout_path === null
    ? `${create}, run the repo's bootstrap in the new checkout`
    : `${open}; if that answers \`worktree_not_found\` the checkout is gone, so ${create} and run ` +
      "the repo's bootstrap in it"
  const setUp = `${worktree}, then ${START_AGENT}`
  if (task.phase === taskRow('queued').onClear) {
    return `${setUp}, then ${briefCommand(task, '<root pane>', hpipe)}`
  }
  return `${setUp}; ${handoffPastBrief(run, task, hpipe)}`
}

/**
 * What is left of a dispatch still inside its bootstrap grace, from the worktree
 * step on when there is no worktree yet.
 */
export function remainingDispatchSteps(run: Run, task: Task, hpipe: string): string {
  if (task.workspace_id === null) return dispatchWorkerCommand(run, task, hpipe)
  return `once the repo's bootstrap has run in its checkout, ${START_AGENT}, then ` +
    briefCommand(task, '<root pane>', hpipe)
}

/**
 * Records the worker's pane, and re-arms the stall ladder when that changes who
 * the task is waiting on. The ladder is keyed on the phase entry, which a bind
 * does not touch, so without the re-arm the orchestrator's probes about an empty
 * worktree count toward escalating a worker that has never been probed.
 */
export function bindWorkerPane(run: Run, task: Task, paneId: string, now: number): boolean {
  if (task.pane_id === paneId) return false
  task.pane_id = paneId
  // Any other row's ladder probes the orchestrator, whose silence a new worker
  // pane does not change.
  if (taskRow(task.phase).actor !== 'worker') return true
  task.stall = {
    at: task.phase_entered_at, run_at: run.phase_entered_at,
    last_probe_at: now, probes: 0, undelivered: 0, holds: 0,
  }
  return true
}

/**
 * Looks before it starts anything: hooks are at-most-once, so a lost
 * `pane.agent_detected` leaves a running agent's task looking exactly like this.
 * The pane is not named because the ledger never learns it: `worktree.created`
 * carries no root pane.
 */
export function startWorkerCommand(run: Run, task: Task, workspaceId: string, hpipe: string): string {
  const look = `check \`herdr pane list --workspace ${workspaceId}\` first`
  if (task.phase === taskRow('queued').onClear) {
    const dispatch = briefCommand(task, null, hpipe)
    return `${look}. If an agent is already there, its detection was missed: ${dispatch} records ` +
      'it and hands it the brief, so `herdr pane read` it before, in case it already has one. ' +
      `If there is none, ${START_AGENT}, then ${dispatch}`
  }
  // `dispatch --task` refuses every phase but the briefed one.
  return `${look}. If there is none, ${START_AGENT}; ${handoffPastBrief(run, task, hpipe)}`
}
