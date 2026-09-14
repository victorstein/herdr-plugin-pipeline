import { enterTaskPhase } from '../lib/machine'
import type { QueuedEvent, Run, SessionKey, Task } from '../lib/types'

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
  runs: Run[], events: QueuedEvent[], session: SessionKey, orchestratorPanes: Set<string>,
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
        enterTaskPhase(run, task, 'failed', 'agent released')
        wake.push({ run, task, text: `${task.branch} (#${task.issue}, ${task.task_id}) agent released` })
      } else if (event.pane_id) {
        task.pane_id = event.pane_id
      }
      changed = true
      continue
    }

    if (event.kind === 'pane.exited') {
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
      if (event.agent_status === 'blocked' || event.agent_status === 'done' || event.agent_status === 'idle') {
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
 * At most one orchestrator-owned advance per orchestrator per tick. Every
 * orchestrator-owned row gates on the same pane reading idle, so without this
 * several phases enter together and the digest's single prompt slot has no winner.
 */
export function pickOneAdvance(runs: Run[]): Run[] {
  const seen = new Set<string>()
  const picked: Run[] = []
  for (const run of runs) {
    const pane = run.orchestrator_pane
    if (!pane || seen.has(pane)) continue
    seen.add(pane)
    picked.push(run)
  }
  return picked
}
