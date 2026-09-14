import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './store'
import type { Orchestrator, Run, SessionKey } from './types'

const FINISHED: ReadonlySet<string> = new Set(['done'])

const runsDir = (stateDir: string, session: SessionKey) => join(stateDir, 'runs', session)
const orchestratorsPath = (stateDir: string) => join(stateDir, 'orchestrators.json')

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
    phase: 'spec',
    pass: 1,
    phase_entered_at: Date.now(),
    escalated_from: null,
    orchestrator_pane: null,
    artifacts: { spec: null, plan: null, verdicts: {} },
    tasks: [],
    history: [],
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
  return runs.find((r) => r.repo_key === repoKey && !FINISHED.has(r.phase)) ?? null
}

export async function runForWorkspace(
  stateDir: string, session: SessionKey, workspaceId: string,
): Promise<Run | null> {
  const runs = await listRuns(stateDir, session)
  return runs.find((r) => r.tasks.some((t) => t.workspace_id === workspaceId)) ?? null
}

const orchestratorKey = (session: SessionKey, repoKey: string) => `${session}/${repoKey}`

export async function writeOrchestrator(
  stateDir: string, session: SessionKey, repoKey: string, value: Orchestrator,
): Promise<void> {
  const all = (await readJson<Record<string, Orchestrator>>(orchestratorsPath(stateDir))) ?? {}
  all[orchestratorKey(session, repoKey)] = value
  await writeJson(orchestratorsPath(stateDir), all)
}

export async function readOrchestrator(
  stateDir: string, session: SessionKey, repoKey: string,
): Promise<Orchestrator | null> {
  const all = (await readJson<Record<string, Orchestrator>>(orchestratorsPath(stateDir))) ?? {}
  return all[orchestratorKey(session, repoKey)] ?? null
}

export async function allOrchestratorPanes(
  stateDir: string, session: SessionKey,
): Promise<Set<string>> {
  const all = (await readJson<Record<string, Orchestrator>>(orchestratorsPath(stateDir))) ?? {}
  const panes = new Set<string>()
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(`${session}/`)) panes.add(value.pane_id)
  }
  return panes
}
