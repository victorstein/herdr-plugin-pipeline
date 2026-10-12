import { fetchFromOrigin, trackingRefspec } from '../lib/dispatch-base'
import type { Run, TaskPhase } from '../lib/types'

const LANDING_PHASES: ReadonlySet<TaskPhase> = new Set(['land-queue', 'sync', 'merge'])

/**
 * One fetch of the batch branch alone, by explicit refspec, for each single-PR run
 * with a task waiting to land. Task branches are never fetched for landing: one
 * deleted branch fails a fetch that names it, and the landing reads only the
 * recorded `land_sha` and the batch. A failure is recorded from when it started,
 * so status can say how long landings have gone unseen.
 */
export async function fetchBatches(
  runs: readonly Run[], fetch: (repoRoot: string, refspec: string) => Promise<string | null> = fetchFromOrigin,
  now: number = Date.now(),
): Promise<void> {
  for (const run of runs) {
    const batch = run.batch
    if (batch === undefined || !run.tasks.some((t) => LANDING_PHASES.has(t.phase))) continue
    const failed = await fetch(run.repo_root, trackingRefspec(batch.branch))
    if (failed === null) batch.fetch_error = null
    else batch.fetch_error = { reason: failed, since: batch.fetch_error?.since ?? now }
  }
}
