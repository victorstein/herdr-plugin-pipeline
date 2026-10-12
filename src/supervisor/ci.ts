import type { HeadCi } from '../lib/gh'
import type { CiBucket, Run, Task } from '../lib/types'

export interface CiChange { run: Run; task: Task; bucket: CiBucket }

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

      const head = await poll(task.pr, run.repo_root)
      // A gh failure must not look like a verdict.
      if (head === null) continue
      if (task.ci_head?.sha !== head.headSha) task.ci_head = { sha: head.headSha, seen_at: now }
      const settling = now - task.ci_head.seen_at < CI_SETTLE_MS
      const bucket = head.bucket === 'pass' && settling ? 'pending' : head.bucket
      if (bucket === task.ci) continue

      task.ci = bucket
      changes.push({ run, task, bucket })
    }
  }

  return changes
}
