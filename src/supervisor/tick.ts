import { abandonDecisions } from '../lib/decisions'
import { filesOverlap, isInFlight } from '../lib/gating'
import { enterTaskPhase } from '../lib/machine'
import { runRow, taskRow } from '../lib/phases'
import type { QueuedEvent, Run, SessionKey, Task } from '../lib/types'

const MS_PER_MINUTE = 60_000

/**
 * Clamped, matching `src/lib/status.ts:12-14`. A third private copy of this
 * arithmetic is deliberate: sharing would mean exporting from `status.ts`, which
 * belongs to #14 and is being edited in the same batch.
 */
export function ageMinutes(sinceMs: number, now: number): number {
  return Math.max(0, Math.floor((now - sinceMs) / MS_PER_MINUTE))
}

/**
 * Whose move it is, keyed on the phase row rather than the phase name so a row
 * added to TASK_ROWS gets a correct clause with no edit here. Shared by the
 * digest line and the parked-task footer so the two cannot drift.
 */
export function actionFor(run: Run, task: Task, hpipe: string): string {
  const row = taskRow(task.phase)

  if (task.phase === 'done') return 'nothing for you — this task is finished'
  if (row.terminal === true) return 'dead end, needs a human'
  if (task.phase === 'escalated') {
    const from = task.escalated_from ?? '<phase>'
    return `needs a human: \`${hpipe} rewind ${run.run_id} ${from} --task ${task.task_id}\``
  }
  if (row.actor === 'orchestrator') return 'YOUR move'
  if (row.actor === 'worker') return "worker's move"
  if (task.phase === 'blocked-on-files') {
    // Mirrors `src/lib/status.ts:51-60`: only a holder that has stopped moving is
    // releasable, and this row has no escalation path of its own — `files` is not
    // in stall.ts's ESCALATING_SIGNALS, so the ladder probes it to the cap and
    // then goes quiet forever.
    const stuck = run.tasks.find(
      (t) => t.task_id !== task.task_id &&
        isInFlight(t) && filesOverlap(task.files, t.files) &&
        (taskRow(t.phase).terminal === true || t.phase === 'escalated'),
    )
    if (stuck) return `YOUR move: \`${hpipe} release --task ${stuck.task_id}\``
  }
  return 'nothing for you — the supervisor is driving'
}

export interface WakeLine {
  run: Run
  task: Task | null
  text: string
}

export interface ApplyResult {
  changed: boolean
  wake: WakeLine[]
}

function findTask(runs: Run[], predicate: (t: Task) => boolean): { run: Run; task: Task } | null {
  for (const run of runs) {
    const task = run.tasks.find(predicate)
    if (task) return { run, task }
  }
  return null
}

export function applyEvents(
  runs: Run[], events: QueuedEvent[], session: SessionKey,
  orchestratorPanes: Set<string>, wakeOn: ReadonlySet<string> = new Set(['blocked', 'done', 'idle']),
): ApplyResult {
  let changed = false
  const wake: WakeLine[] = []

  for (const event of events) {
    if (event.session !== session) continue
    if (event.pane_id && orchestratorPanes.has(event.pane_id)) continue

    if (event.kind === 'worktree.created' && event.branch && event.workspace_id) {
      const found = findTask(runs, (t) => t.branch === event.branch && t.workspace_id === null)
      if (found) {
        found.task.workspace_id = event.workspace_id
        found.task.checkout_path = event.checkout_path ?? null
        found.task.adopted_at = Date.now()
        changed = true
      }
      continue
    }

    if (!event.pane_id && !event.workspace_id) continue

    const found = findTask(
      runs,
      (t) =>
        (event.pane_id !== undefined && t.pane_id === event.pane_id) ||
        (event.workspace_id !== undefined && t.workspace_id === event.workspace_id),
    )
    if (!found) continue
    const { run, task } = found

    if (event.kind === 'pane.agent_detected') {
      if (event.released === true) {
        // A dead pane can never deliver or answer, so its open question is
        // stranded — closing it keeps `hpipe status` and the stall probe honest.
        if (task.phase === 'blocked-on-decision') abandonDecisions(task)
        enterTaskPhase(run, task, 'failed', 'agent released')
        wake.push({ run, task, text: `${task.branch} (#${task.issue}, ${task.task_id}) agent released` })
      } else if (event.pane_id) {
        task.pane_id = event.pane_id
      }
      changed = true
      continue
    }

    if (event.kind === 'pane.exited') {
      if (task.phase === 'blocked-on-decision') abandonDecisions(task)
      enterTaskPhase(run, task, 'failed', task.pr ? 'pane exited after PR' : 'pane exited with no PR')
      wake.push({
        run, task,
        text: `${task.branch} (#${task.issue}, ${task.task_id}) exited${task.pr ? '' : ', no PR'}`,
      })
      changed = true
      continue
    }

    if (event.kind === 'pane.agent_status_changed' && event.agent_status) {
      if (task.agent_status === event.agent_status) continue
      task.agent_status = event.agent_status
      changed = true
      if (wakeOn.has(event.agent_status)) {
        wake.push({
          run, task,
          text: `${task.branch} (#${task.issue}, ${task.task_id}) ${event.agent_status}`,
        })
      }
    }
  }

  return { changed, wake }
}

/**
 * At most one orchestrator-owned advance per orchestrator per tick. Runs in a
 * pane-releasing phase are skipped: their `orchestrator_pane` is never cleared,
 * so without this such a run holds its pane forever and the next `hpipe start`
 * in the same terminal is silently never advanced.
 */
export function pickOneAdvance(runs: Run[]): Run[] {
  const seen = new Set<string>()
  const picked: Run[] = []
  for (const run of runs) {
    if (runRow(run.phase).releasesPane === true) continue
    const pane = run.orchestrator_pane
    if (!pane || seen.has(pane)) continue
    seen.add(pane)
    picked.push(run)
  }
  return picked
}
