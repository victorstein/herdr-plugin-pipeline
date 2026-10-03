import { beadsSlug, readBeadsProject } from '../lib/beads-project'
import { readBoards } from '../lib/boards'
import { loadConfig } from '../lib/config'
import { Herdr } from '../lib/herdr'
import { repoContext } from '../lib/repo'
import { sessionKey } from '../lib/session'
import { ensureWorkspace } from '../startup'
import { type BoardDeps, openBoard } from '../supervisor/boards'

export interface OpenBoardActionDeps {
  stateDir: string
  session: string
  pluginId: string
  repoKey: string | null
  workspaceId: () => Promise<string | null>
  now: () => number
  herdr: BoardDeps['herdr']
  log: (message: string) => void
  error: (message: string) => void
}

/** Closes this repo's recorded board, if any, and opens a fresh one. */
export async function openBoardAction(deps: OpenBoardActionDeps): Promise<number> {
  if (deps.repoKey === null) {
    deps.error('[pipeline] "Open board" must be invoked from a pane inside a git repository')
    return 1
  }
  const slug = beadsSlug(deps.repoKey)
  if ((await readBeadsProject(deps.stateDir, slug)) === null) {
    deps.error('[pipeline] this repo has no Beads store yet — run "Set up Beads for this repo" first')
    return 1
  }
  const workspaceId = await deps.workspaceId()
  if (workspaceId === null) {
    deps.error('[pipeline] could not resolve the pipeline workspace')
    return 1
  }

  const recorded = (await readBoards(deps.stateDir, deps.session))[slug]
  if (recorded?.pane_id) await deps.herdr.paneClose(recorded.pane_id)
  const opened = await openBoard(slug, {
    stateDir: deps.stateDir, session: deps.session, pluginId: deps.pluginId, workspaceId, now: deps.now, herdr: deps.herdr,
  }, recorded)
  if (!opened) {
    deps.error(`[pipeline] the board for ${slug} was not opened — the supervisor may have just opened one; check the pipeline workspace`)
    return 1
  }
  deps.log(`[pipeline] board opened for ${slug}`)
  return 0
}

if (import.meta.main) {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
  if (!stateDir || !configDir) process.exit(0)
  const session = sessionKey()
  const herdr = new Herdr()
  process.exit(await openBoardAction({
    stateDir,
    session,
    pluginId: process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline',
    repoKey: (await repoContext())?.repoKey ?? null,
    workspaceId: async () =>
      ensureWorkspace(herdr, stateDir, session, (await loadConfig(configDir)).PIPELINE_WORKSPACE_LABEL),
    now: Date.now,
    herdr,
    log: console.log,
    error: console.error,
  }))
}
