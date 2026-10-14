import { enqueue, isCurrent } from './outbox'
import { taskRow } from './phases'
import type { Run, Task, TaskPhase } from './types'

/** The PR has merged: only the supervisor's close and teardown are left, and the worker has nothing to stop. */
const PAST_THE_WORKER: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['close', 'teardown'])

/**
 * The workers an abort tells to stop and a resume tells to carry on. After an
 * abort both workers of a live smoke run kept working, and one learned of it only
 * when its `hpipe submit` was refused. Measured on a live run. An agent still owed
 * its brief is left alone: a notice as its first message reads as its task (#105).
 */
export function workersToStop(run: Run): Task[] {
  return run.tasks.filter((task) => task.pane_id !== null && task.awaiting_brief !== true &&
    taskRow(task.phase).terminal !== true && !PAST_THE_WORKER.has(task.phase))
}

export function queueStops(run: Run, texts: ReadonlyMap<string, string>, now: number): Task[] {
  return workersToStop(run).flatMap((task) => {
    const text = texts.get(task.task_id)
    if (text === undefined) return []
    enqueue(run, { to: 'worker', taskId: task.task_id, text, kind: 'abort' }, now)
    return [task]
  })
}

/**
 * Takes back every stop notice still undelivered, and returns whose: a worker that
 * never read one never stopped, so it is owed no word that the run carries on.
 */
export function withdrawStops(run: Run): Set<string> {
  const outbox = run.outbox ?? []
  const unread = outbox.filter((entry) => entry.kind === 'abort' && entry.task_id !== null && isCurrent(run, entry))
  run.outbox = outbox.filter((entry) => entry.kind !== 'abort')
  return new Set(unread.map((entry) => entry.task_id as string))
}
