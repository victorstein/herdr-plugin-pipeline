import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TASK_ROWS, runRow } from './phases'
import { LockTimeoutError, readJson, writeJson, writeJsonIf } from './store'
import type { Orchestrator, Run, RunPhase, SessionKey } from './types'

const runsDir = (stateDir: string, session: SessionKey) => join(stateDir, 'runs', session)
const runPath = (stateDir: string, session: SessionKey, runId: string) =>
  join(runsDir(stateDir, session), `${runId}.json`)

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
    revision: 0,
    intake_closed: false,
    passes: {},
  }
}

export class StaleRunError extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} changed on disk since it was read`)
    this.name = 'StaleRunError'
  }
}

/**
 * Refuses to overwrite a run someone else saved after this copy was read, and
 * throws rather than returning a flag so a caller that forgets to handle it
 * fails loudly instead of clobbering. The CLI and the supervisor both
 * read-modify-write the whole file, and before this check a CLI rewind landing
 * inside a supervisor tick was silently undone by that tick's save.
 * Measured on a live run.
 */
export async function saveRun(stateDir: string, run: Run): Promise<void> {
  const base = run.revision ?? 0
  const next: Run = { ...run, revision: base + 1 }
  const written = await writeJsonIf(
    runPath(stateDir, run.session, run.run_id),
    next,
    (current) => current === null || ((current as Partial<Run>).revision ?? 0) === base,
  )
  if (!written) throw new StaleRunError(run.run_id)
  run.revision = next.revision
}

/** A save that left the file untouched, so the caller can drop its copy and read again. */
export const isUnlandedSave = (error: unknown): error is StaleRunError | LockTimeoutError =>
  error instanceof StaleRunError || error instanceof LockTimeoutError

/** What a command prints when its write never landed, so it is never mistaken for success. */
export function unlandedSaveMessage(error: StaleRunError | LockTimeoutError): string {
  return error instanceof StaleRunError
    ? `run ${error.runId} kept changing under this command; nothing was written — run it again`
    : `could not lock ${error.lockPath}; nothing was written — run it again`
}

export async function loadRun(
  stateDir: string, session: SessionKey, runId: string,
): Promise<Run | null> {
  return readJson<Run>(runPath(stateDir, session, runId))
}

const STALE_RETRY_MAX = 5

/**
 * Runs a whole load-validate-mutate-save attempt again when its save lost a
 * race, so the retry re-reads fresh state and re-checks every precondition
 * against it rather than replaying a stale decision.
 */
export async function retryOnStaleRun<T>(
  attempt: () => Promise<T>, maxAttempts = STALE_RETRY_MAX,
): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt()
    } catch (error) {
      if (!(error instanceof StaleRunError) || tries >= maxAttempts) throw error
    }
  }
}

/**
 * Records one thing already done outside the ledger — a worktree removed, a
 * prompt sent — so it can be written onto a freshly read run. Each checks its own
 * precondition against that run and does nothing if a CLI command moved the
 * record on meanwhile.
 */
export type RunEffect = (run: Run) => void

export type SaveOutcome = 'saved' | 'reapplied'

/**
 * Saves `run`, or — when a CLI command landed first — re-reads it and saves the
 * fresh copy with only `effects` applied. Everything else the caller computed on
 * its stale copy is dropped, which is the point: the command wins. What cannot be
 * dropped is an action already taken outside the ledger, because the next pass
 * would take it again. Throws when there is nothing worth salvaging.
 */
export async function saveOrReapply(
  stateDir: string, run: Run, effects: readonly RunEffect[],
): Promise<SaveOutcome> {
  try {
    await saveRun(stateDir, run)
    return 'saved'
  } catch (error) {
    if (!isUnlandedSave(error) || effects.length === 0) throw error
    const reapply = () => retryOnStaleRun(async () => {
      const fresh = await loadRun(stateDir, run.session, run.run_id)
      if (fresh === null) throw error
      for (const apply of effects) apply(fresh)
      await saveRun(stateDir, fresh)
      return 'reapplied' as const
    })
    // One more bounded wait: giving up here drops actions already taken, which the
    // next tick would repeat as a duplicate prompt.
    try {
      return await reapply()
    } catch (reapplyError) {
      if (!(reapplyError instanceof LockTimeoutError)) throw reapplyError
      return reapply()
    }
  }
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
  reach: RunReach
}

/**
 * Which runs a command may act on, picked at every call site so none reaches for
 * `terminal` or `releasesPane` on its own. `driven` is for a command whose effect
 * only the supervisor carries forward: on a parked run it would strand. A finished
 * run is only ever reached by naming it, never inferred.
 */
export type RunReach = 'driven' | 'unfinished' | 'finished-if-named'

export type RunResolution =
  | { ok: true; run: Run }
  | { ok: false; reason: 'no-such-run' }
  | { ok: false; reason: 'terminal'; run: Run }
  | { ok: false; reason: 'parked'; run: Run }
  | { ok: false; reason: 'wrong-phase'; run: Run }
  | { ok: false; reason: 'unreadable'; run: Run }
  | { ok: false; reason: 'none'; excluded: Run[] }
  | { ok: false; reason: 'ambiguous'; candidates: Run[] }

/**
 * Every phase question below is throw-safe, and all of them live here rather
 * than in `phases.ts` beside `runRow`/`taskRow` — one address, so the next
 * caller reading a phase off disk finds them instead of writing another spelling.
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

/**
 * "Is the supervisor acting on this run?" — a different question from
 * `runPhaseState`'s "is it finished?". `releasesPane` covers `escalated` as well
 * as `done`, so a run parked in `escalated` is unfinished yet nothing announces
 * its decisions or probes its tasks until a human rewinds it.
 */
export function runIsDriven(run: Run): boolean {
  try {
    return runRow(run.phase).releasesPane !== true
  } catch {
    return false
  }
}

/**
 * By id alone, in any phase — finished, parked, or in no row at all. Only the
 * escape commands use it: `rewind` is how a finished or unreadable run is left,
 * so resolveRun's legality filters would lock that door from the outside.
 */
export async function runById(
  stateDir: string, session: SessionKey, runId: string,
): Promise<Run | null> {
  return (await listRuns(stateDir, session)).find((r) => r.run_id === runId) ?? null
}

const withinReach = (run: Run, reach: RunReach): boolean =>
  runPhaseState(run) === 'live' && (reach !== 'driven' || runIsDriven(run))

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
    if (state === 'terminal' && query.reach !== 'finished-if-named') {
      return { ok: false, reason: 'terminal', run: named }
    }
    if (query.reach === 'driven' && !runIsDriven(named)) {
      return { ok: false, reason: 'parked', run: named }
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
    (r) => withinReach(r, query.reach) &&
      (query.phases === null || query.phases.includes(r.phase)),
  )

  const only = matched[0]
  if (matched.length === 1 && only) return { ok: true, run: only }
  if (matched.length > 1) return { ok: false, reason: 'ambiguous', candidates: matched }
  return { ok: false, reason: 'none', excluded: withTask }
}
