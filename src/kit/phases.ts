import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION_SOCKET = /\/sessions\/([^/]+)\/herdr\.sock$/

/** The herdr session stein.pipeline files its runs under, resolved the way hpipe resolves it. */
export function sessionKey(env: Record<string, string | undefined> = process.env): string {
  if (env.HERDR_SESSION) return env.HERDR_SESSION
  return SESSION_SOCKET.exec(env.HERDR_SOCKET_PATH ?? '')?.[1] ?? 'default'
}

// herdr gives each plugin a sibling directory under one plugins root
export const pipelineRunsDir = (ownStateDir: string, session: string) =>
  join(ownStateDir, '..', 'stein.pipeline', 'runs', session)

interface RunFile {
  phase?: string
  phase_entered_at?: number
  tasks?: { pane_id?: string | null; phase?: string }[]
}

/**
 * Each live pipeline worker's phase, by pane id. A pane in two runs takes the newest run's phase.
 * Finished runs are skipped: they keep their workers' pane ids, which herdr hands to new panes.
 */
export async function workerPhases(runsDir: string): Promise<Record<string, string>> {
  let names: string[]
  try {
    names = await readdir(runsDir)
  } catch {
    return {}
  }
  const runs: RunFile[] = []
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      runs.push(JSON.parse(await readFile(join(runsDir, name), 'utf8')))
    } catch {
      // a run caught mid-write is read again on the next refresh
    }
  }
  runs.sort((a, b) => (a.phase_entered_at ?? 0) - (b.phase_entered_at ?? 0))
  const phases: Record<string, string> = {}
  for (const run of runs) {
    if (run.phase === 'done' || !Array.isArray(run.tasks)) continue
    for (const task of run.tasks) if (task.pane_id && task.phase) phases[task.pane_id] = task.phase
  }
  return phases
}
