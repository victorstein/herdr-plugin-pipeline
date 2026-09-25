import { taskRow } from './phases'
import type { Task } from './types'

export const UNRECORDED_PR = 'a PR number this task never recorded'

/**
 * What a task's row is waiting for, as a noun phrase that completes "waiting
 * for …". The stall probe and the move clause of the digest and `hpipe status`
 * all read it, so they cannot name one row differently: a task parked in `merge`
 * read as a bare "YOUR move" in status while its probe said "PR #7 to be
 * merged". Measured on a live run.
 */
export function awaitedFor(task: Task): string {
  const row = taskRow(task.phase)
  switch (row.signal) {
    case 'artifact':
      return `its ${row.artifact ?? task.phase} artifact`
    case 'verdict':
      return 'its review verdict'
    case 'pr':
      return `a pushed PR for ${task.branch} (#${task.issue})`
    case 'ci':
      return task.pr === null ? UNRECORDED_PR : `CI on PR #${task.pr}`
    case 'merged':
      return task.pr === null ? UNRECORDED_PR : `PR #${task.pr} to be merged`
    case 'closed':
      return `issue #${task.issue} to close`
    case 'files':
      return 'the files another task holds'
    case 'manual':
      return task.pending_answer === null
        ? 'an answer to the open decision'
        : 'its recorded answer to reach the worker'
    case 'worktree':
      return 'its worktree to be removed'
    default:
      return `whatever clears ${task.phase}`
  }
}
