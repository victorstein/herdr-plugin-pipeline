import { beadsSlug } from '../lib/beads-project'
import { type BoardRegistry, updateBoards } from '../lib/boards'
import { type PaneHold, readPaneHolds } from '../lib/delivery-health'
import { isCurrentSchemaRun, listRuns, runPhaseState } from '../lib/ledger'
import { supervisorState } from '../lib/pidfile'
import type { Run, SessionKey } from '../lib/types'

const newest = (runs: Run[]) => [...runs].sort((a, b) => b.phase_entered_at - a.phase_entered_at)[0] ?? null

// a run in no phase row, or of another schema, would make the board's row lookups throw
export async function runForSlug(stateDir: string, session: SessionKey, slug: string): Promise<Run | null> {
  const runs = (await listRuns(stateDir, session))
    .filter((r) => isCurrentSchemaRun(r) && runPhaseState(r) !== 'unreadable' && beadsSlug(r.repo_key) === slug)
  return newest(runs.filter((r) => runPhaseState(r) === 'live')) ?? newest(runs)
}

export async function loadHolds(stateDir: string, session: SessionKey): Promise<Record<string, PaneHold>> {
  const supervisor = await supervisorState(stateDir, session)
  return readPaneHolds(stateDir, session, supervisor.state === 'live' ? supervisor.info.pid : undefined)
}

export function clearedFor(boards: BoardRegistry, slug: string, runId: string): Set<string> {
  const cleared = boards[slug]?.cleared
  return new Set(cleared?.run_id === runId ? cleared.tasks : [])
}

/** False when no record names this board yet, so there is nowhere to keep the clear. */
export async function recordCleared(stateDir: string, session: SessionKey, slug: string, runId: string, taskId: string): Promise<boolean> {
  return updateBoards(stateDir, session, (boards) => {
    const board = boards[slug]
    if (!board) return false
    const tasks = board.cleared?.run_id === runId ? board.cleared.tasks : []
    if (!tasks.includes(taskId)) board.cleared = { run_id: runId, tasks: [...tasks, taskId] }
    return true
  })
}
