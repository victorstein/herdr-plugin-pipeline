import { enqueue, isCurrent, queuedResume, queuedWorkerPrompt } from './outbox'
import { taskRow } from './phases'
import type { Run, Task, TaskPhase } from './types'

/** The PR has merged: only the supervisor's close and teardown are left, and the worker has nothing to stop. */
const PAST_THE_WORKER: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['close', 'teardown'])

/**
 * The workers an abort tells to stop. After an abort both workers of a live smoke
 * run kept working, and one learned of it only when its `hpipe submit` was refused.
 * Measured on a live run. An agent still owed its brief is left alone, since a
 * notice as its first message reads as its task (#105), unless a dispatch is
 * handing it the brief right now: that brief lands after the abort.
 */
export function workersToStop(run: Run, briefing: string | null = null): Task[] {
  return run.tasks.filter((task) => task.pane_id !== null &&
    (task.awaiting_brief !== true || task.task_id === briefing) &&
    taskRow(task.phase).terminal !== true && !PAST_THE_WORKER.has(task.phase))
}

/**
 * The workers a resume tells to carry on: only a phase the worker drives has a
 * prompt to carry on from. Any other gets its next prompt when that comes, and
 * a worker with a phase prompt or a resume already queued is restarted by that.
 */
export function workersToCarryOn(run: Run): Task[] {
  return workersToStop(run).filter((task) => taskRow(task.phase).actor === 'worker' &&
    queuedWorkerPrompt(run, task) === null && queuedResume(run, task) === null)
}

export function queueStops(run: Run, tasks: readonly Task[], texts: ReadonlyMap<string, string>, now: number): Task[] {
  return tasks.flatMap((task) => {
    const text = texts.get(task.task_id)
    if (text === undefined) return []
    enqueue(run, { to: 'worker', taskId: task.task_id, text, kind: 'abort' }, now)
    return [task]
  })
}

/**
 * Takes back every stop notice, and returns whose were still unsent. Read while
 * the run is still aborted: a stop notice lapses with the abort.
 */
export function withdrawStops(run: Run): string[] {
  const outbox = run.outbox ?? []
  const unsent = outbox.filter((entry) => entry.kind === 'abort' && entry.task_id !== null && isCurrent(run, entry))
  run.outbox = outbox.filter((entry) => entry.kind !== 'abort')
  return unsent.map((entry) => entry.task_id as string)
}
