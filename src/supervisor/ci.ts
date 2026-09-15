import type { CiBucket, Run, Task } from '../lib/types'

export interface CiChange { run: Run; task: Task; bucket: CiBucket }

export async function ciTransitions(
  runs: Run[], poll: (pr: number, repoRoot: string) => Promise<CiBucket>,
): Promise<CiChange[]> {
  const changes: CiChange[] = []

  for (const run of runs) {
    for (const task of run.tasks) {
      if (task.phase !== 'ci' || task.pr === null) continue

      const bucket = await poll(task.pr, run.repo_root)
      // A gh failure must not look like a verdict.
      if (bucket === 'unknown') continue
      if (bucket === task.ci) continue

      task.ci = bucket
      changes.push({ run, task, bucket })
    }
  }

  return changes
}
