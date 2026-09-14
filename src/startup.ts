import { chmodSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from './lib/config'
import { Herdr } from './lib/herdr'
import { readPid } from './lib/pidfile'
import { gcStaleTmp } from './lib/queue'
import { sessionKey } from './lib/session'

const SUPERVISOR_LABEL = 'Pipeline supervisor'
const ONE_HOUR_MS = 60 * 60 * 1000

const workspaceIdPath = (stateDir: string, session: string) =>
  join(stateDir, `workspace.${session}.id`)

export async function ensureWorkspace(
  herdr: Herdr, stateDir: string, session: string, label: string,
): Promise<string | null> {
  const workspaces = await herdr.workspaceList()

  const recorded = (await Bun.file(workspaceIdPath(stateDir, session)).exists())
    ? (await Bun.file(workspaceIdPath(stateDir, session)).text()).trim()
    : null
  if (recorded && workspaces.some((w) => w.workspace_id === recorded)) return recorded

  // Labels are not unique — herdr enforces nothing and the user can rename any workspace.
  const matching = workspaces.filter((w) => w.label === label)
  if (matching.length === 1 && matching[0]) {
    await Bun.write(workspaceIdPath(stateDir, session), matching[0].workspace_id)
    return matching[0].workspace_id
  }
  if (matching.length > 1) {
    console.error(`[pipeline] ${matching.length} workspaces labelled "${label}" — reporting ambiguity`)
  }

  const created = await herdr.workspaceCreate(label)
  const id = created.result?.workspace.workspace_id
  if (!id) {
    console.error(`[pipeline] could not create workspace: ${created.code ?? 'unknown'}`)
    return null
  }
  await Bun.write(workspaceIdPath(stateDir, session), id)
  return id
}

export async function reapGhostPanes(
  herdr: Herdr, workspaceId: string, livePanePid: number | null,
): Promise<string[]> {
  const panes = await herdr.paneList(workspaceId)
  const closed: string[] = []

  for (const pane of panes) {
    if (pane.label !== SUPERVISOR_LABEL) continue

    const shellPid = await herdr.paneShellPid(pane.pane_id)
    // undefined means the pid lookup failed. Closing a pane we cannot identify
    // risks killing the live supervisor, so uncertainty means leave it alone.
    if (shellPid === undefined) continue
    if (livePanePid !== null && shellPid === livePanePid) continue

    await herdr.paneClose(pane.pane_id)
    closed.push(pane.pane_id)
  }

  return closed
}

/**
 * Clears the shell pane `workspace create` opens alongside the supervisor. It must
 * run AFTER the supervisor pane exists: closing a workspace's last pane destroys
 * the workspace, so clearing it at creation time deletes the very workspace the
 * supervisor was about to open into.
 */
export async function clearStrayPanes(herdr: Herdr, workspaceId: string): Promise<string[]> {
  const panes = await herdr.paneList(workspaceId)
  if (panes.length <= 1) return []

  const closed: string[] = []
  for (const pane of panes) {
    if (pane.label === SUPERVISOR_LABEL) continue
    await herdr.paneClose(pane.pane_id)
    closed.push(pane.pane_id)
  }
  return closed
}

export async function linkHpipe(target: string, linkPath: string): Promise<void> {
  mkdirSync(dirname(linkPath), { recursive: true })
  chmodSync(target, 0o755)
  try {
    lstatSync(linkPath)
    unlinkSync(linkPath)
  } catch {
    // Nothing there yet.
  }
  symlinkSync(target, linkPath)
}

async function main(): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? process.cwd()
  const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'
  if (!stateDir || !configDir) process.exit(0)

  const session = sessionKey()
  const config = await loadConfig(configDir)
  const herdr = new Herdr()

  await gcStaleTmp(join(stateDir, 'queue', session), ONE_HOUR_MS)

  if (config.HPIPE_LINK) {
    await linkHpipe(join(pluginRoot, 'src', 'cli.ts'), config.HPIPE_LINK_PATH)
  }

  const workspaceId = await ensureWorkspace(herdr, stateDir, session, config.PIPELINE_WORKSPACE_LABEL)
  if (!workspaceId) return

  const live = await readPid(stateDir, session)
  const ghosts = await reapGhostPanes(herdr, workspaceId, live?.pane_pid ?? null)
  if (ghosts.length > 0) console.log(`[pipeline] closed ghost panes: ${ghosts.join(', ')}`)

  const opened = await herdr.pluginPaneOpen(pluginId, 'supervisor', workspaceId)
  if (!opened.ok) {
    // herdr reports this in the body while exiting 0 — checking the exit code would miss it.
    console.error(`[pipeline] could not open supervisor pane: ${opened.code} ${opened.message}`)
    return
  }

  const strays = await clearStrayPanes(herdr, workspaceId)
  if (strays.length > 0) console.log(`[pipeline] closed stray panes: ${strays.join(', ')}`)
}

if (import.meta.main) await main()
