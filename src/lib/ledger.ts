import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TASK_ROWS, runRow } from './phases'
import { readJson, writeJson } from './store'
import type { Orchestrator, Run, RunPhase, SessionKey } from './types'

const runsDir = (stateDir: string, session: SessionKey) => join(stateDir, 'runs', session)

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

export function newRun(input: {
  session: SessionKey
  socketPath: string
  repoKey: string
  repoRoot: string
  title: string
}): Run {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const suffix = Math.random().toString(36).slice(2, 6)
  const repoName = input.repoRoot.split('/').filter(Boolean).pop() ?? 'repo'

  return {
    run_id: `${repoName}-${date}-${slugify(input.title)}-${suffix}`,
    session: input.session,
    socket_path: input.socketPath,
    repo_key: input.repoKey,
    repo_root: input.repoRoot,
    title: input.title,
    phase: 'intake',
    phase_entered_at: Date.now(),
    escalated_from: null,
    orchestrator_pane: null,
    artifacts: { verdicts: {} },
    tasks: [],
    history: [],
    schema_version: 2,
    intake_closed: false,
    passes: {},
  }
}

export async function saveRun(stateDir: string, run: Run): Promise<void> {
  await writeJson(join(runsDir(stateDir, run.session), `${run.run_id}.json`), run)
}

export async function listRuns(stateDir: string, session: SessionKey): Promise<Run[]> {
  let names: string[]
  try {
    names = readdirSync(runsDir(stateDir, session))
  } catch {
    return []
  }

  const runs: Run[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const run = await readJson<Run>(join(runsDir(stateDir, session), name))
    if (run) runs.push(run)
  }
  return runs
}

export async function activeRunForRepo(
  stateDir: string, session: SessionKey, repoKey: string,
): Promise<Run | null> {
  const runs = await listRuns(stateDir, session)
  return runs.find((r) => r.repo_key === repoKey && !runRow(r.phase).terminal) ?? null
}

export async function runForWorkspace(
  stateDir: string, session: SessionKey, workspaceId: string,
): Promise<Run | null> {
  const runs = await listRuns(stateDir, session)
  return runs.find((r) => r.tasks.some((t) => t.workspace_id === workspaceId)) ?? null
}

// One file per record, mirroring the runs layout above. A single shared
// orchestrators.json would be read-modify-written whole, so two concurrent
// claims in different sessions could silently clobber each other's entry.
const orchestratorPath = (stateDir: string, session: SessionKey, repoKey: string) =>
  join(stateDir, 'orchestrators', session, `${encodeURIComponent(repoKey)}.json`)

export async function writeOrchestrator(
  stateDir: string, session: SessionKey, repoKey: string, value: Orchestrator,
): Promise<void> {
  await writeJson(orchestratorPath(stateDir, session, repoKey), value)
}

export async function readOrchestrator(
  stateDir: string, session: SessionKey, repoKey: string,
): Promise<Orchestrator | null> {
  return readJson<Orchestrator>(orchestratorPath(stateDir, session, repoKey))
}

export async function allOrchestratorPanes(
  stateDir: string, session: SessionKey,
): Promise<Set<string>> {
  const dir = join(stateDir, 'orchestrators', session)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return new Set()
  }

  const panes = new Set<string>()
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const entry = await readJson<Orchestrator>(join(dir, name))
    if (entry) panes.add(entry.pane_id)
  }
  return panes
}

export interface RunQuery {
  /** An explicit `--run`. Replaces the inference filters, never the legality ones. */
  runId: string | null
  repoKey: string | null
  phases: readonly RunPhase[] | null
  taskId: string | null
  /** The caller opts into a finished run by naming it; never inferred. */
  allowTerminal: boolean
}

export type RunResolution =
  | { ok: true; run: Run }
  | { ok: false; reason: 'no-such-run' }
  | { ok: false; reason: 'terminal'; run: Run }
  | { ok: false; reason: 'wrong-phase'; run: Run }
  | { ok: false; reason: 'unreadable'; run: Run }
  | { ok: false; reason: 'none'; excluded: Run[] }
  | { ok: false; reason: 'ambiguous'; candidates: Run[] }

/**
 * Both phase questions below are throw-safe, and both live here rather than in
 * `phases.ts` beside `runRow`/`taskRow` — one address, so the next caller
 * reading a phase off disk finds them instead of writing a fourth spelling.
 *
 * `runRow` throws on a phase with no row and nothing validates what is on disk,
 * so every caller of resolveRun would otherwise inherit a stack trace from one
 * typo'd `hpipe rewind`. An unreadable run is simply not a candidate.
 */
export function runPhaseState(run: Run): 'live' | 'terminal' | 'unreadable' {
  try {
    return runRow(run.phase).terminal === true ? 'terminal' : 'live'
  } catch {
    return 'unreadable'
  }
}

export const taskPhaseIsTerminal = (phase: string): boolean =>
  TASK_ROWS.some((r) => r.phase === phase && r.terminal === true)

export async function resolveRun(
  stateDir: string, session: SessionKey, query: RunQuery,
): Promise<RunResolution> {
  const runs = await listRuns(stateDir, session)

  if (query.runId !== null) {
    const named = runs.find((r) => r.run_id === query.runId)
    if (!named) return { ok: false, reason: 'no-such-run' }
    const state = runPhaseState(named)
    if (state === 'unreadable') return { ok: false, reason: 'unreadable', run: named }
    if (state === 'terminal' && !query.allowTerminal) {
      return { ok: false, reason: 'terminal', run: named }
    }
    if (query.phases !== null && !query.phases.includes(named.phase)) {
      return { ok: false, reason: 'wrong-phase', run: named }
    }
    return { ok: true, run: named }
  }

  const inRepo = runs.filter((r) => query.repoKey === null || r.repo_key === query.repoKey)
  const withTask = inRepo.filter(
    (r) => query.taskId === null || r.tasks.some((t) => t.task_id === query.taskId),
  )
  const matched = withTask.filter(
    (r) => runPhaseState(r) === 'live' &&
      (query.phases === null || query.phases.includes(r.phase)),
  )

  const only = matched[0]
  if (matched.length === 1 && only) return { ok: true, run: only }
  if (matched.length > 1) return { ok: false, reason: 'ambiguous', candidates: matched }
  return { ok: false, reason: 'none', excluded: withTask }
}
