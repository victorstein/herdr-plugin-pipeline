import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TERMINAL_BAD, TERMINAL_OK } from './gating'
import { readJson } from './store'
import type { TaskPhase } from './types'

/**
 * The fields read off disk, typed structurally: run files of every schema
 * version sit side by side, and a v2 task carries no `bead` at all.
 */
interface RunFileTask {
  task_id: string
  phase: string
  bead?: string
}

interface RunFile {
  run_id: string
  phase: string
  tasks?: RunFileTask[]
}

export interface BeadHold {
  session: string
  run_id: string
  task_id: string
  phase: string
}

/** Adoption, `hpipe next` and the reconciler's release rule all read this one predicate. */
export function holdsBead<T extends { phase: string; bead?: string }>(
  run: { phase: string }, task: T,
): task is T & { bead: string } {
  if (task.bead === undefined || run.phase === 'done') return false
  const phase = task.phase as TaskPhase
  return !TERMINAL_OK.has(phase) && !TERMINAL_BAD.has(phase)
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Every session's runs, not only the caller's: a bead held from another herdr session is still taken. */
export async function beadHolds(stateDir: string): Promise<Map<string, BeadHold>> {
  const holds = new Map<string, BeadHold>()
  const runsRoot = join(stateDir, 'runs')
  for (const session of entries(runsRoot).sort()) {
    for (const name of entries(join(runsRoot, session)).filter((n) => n.endsWith('.json')).sort()) {
      const run = await readJson<RunFile>(join(runsRoot, session, name))
      if (run === null) continue
      for (const task of run.tasks ?? []) {
        if (!holdsBead(run, task)) continue
        holds.set(task.bead, { session, run_id: run.run_id, task_id: task.task_id, phase: task.phase })
      }
    }
  }
  return holds
}

export async function heldBy(stateDir: string, bead: string): Promise<BeadHold | null> {
  return (await beadHolds(stateDir)).get(bead) ?? null
}
