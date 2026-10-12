import type { HeadCi } from '../lib/gh'
import type { CiBucket, Run, Task } from '../lib/types'

/** `task` is null for a single-PR run's batch PR. */
export interface CiChange { run: Run; task: Task | null; bucket: CiBucket }

/** What a CI result is recorded on: a task's PR, or a single-PR run's batch PR. */
interface CiHolder { ci: CiBucket | null; ci_head?: { sha: string; seen_at: number } }

/**
 * A push starts its workflows a few seconds later, and until then the head lists
 * only the checks that were already done — berean-os t1 cleared `ci` 10s after
 * entering it, with its build still queued. Measured on a live run (#16).
 */
export const CI_SETTLE_MS = 60_000

export async function ciTransitions(
  runs: Run[], poll: (pr: number, repoRoot: string) => Promise<HeadCi | null>, now: number = Date.now(),
): Promise<CiChange[]> {
  const changes: CiChange[] = []

  for (const run of runs) {
    for (const task of run.tasks) {
      if (task.phase !== 'ci' || task.pr === null) continue
      const bucket = recordHeadCi(task, await poll(task.pr, run.repo_root), now)
      if (bucket !== null) changes.push({ run, task, bucket })
    }
    const batch = run.batch
    if (run.phase === 'ship-ci' && batch !== undefined && batch.pr !== null) {
      const bucket = recordHeadCi(batch, await poll(batch.pr, run.repo_root), now)
      if (bucket !== null) changes.push({ run, task: null, bucket })
    }
  }

  return changes
}

/** The new bucket, or null when nothing changed. A gh failure must not look like a verdict. */
function recordHeadCi(holder: CiHolder, head: HeadCi | null, now: number): CiBucket | null {
  if (head === null) return null
  if (holder.ci_head?.sha !== head.headSha) holder.ci_head = { sha: head.headSha, seen_at: now }
  const settling = now - holder.ci_head.seen_at < CI_SETTLE_MS
  const bucket = head.bucket === 'pass' && settling ? 'pending' : head.bucket
  if (bucket === holder.ci) return null
  holder.ci = bucket
  return bucket
}
