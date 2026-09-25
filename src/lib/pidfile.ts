import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, removeJsonIf, writeJson, writeJsonExclusive } from './store'
import type { SessionKey, SupervisorPid } from './types'

const pidPath = (stateDir: string, session: SessionKey) =>
  join(stateDir, `supervisor.${session}.pid`)

export type SupervisorState =
  | { state: 'none' }
  | { state: 'live'; info: SupervisorPid }
  | { state: 'stale'; info: SupervisorPid }

/** Process start time, used to defeat pid reuse. macOS and Linux both support `ps -o lstart=`. */
export async function processStartedAtMs(pid: number): Promise<number | null> {
  const proc = Bun.spawn(['ps', '-p', String(pid), '-o', 'lstart='], { stdout: 'pipe', stderr: 'ignore' })
  const text = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (text.length === 0) return null
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

export async function writePid(stateDir: string, info: SupervisorPid): Promise<void> {
  await writeJson(pidPath(stateDir, info.session), info)
}

/**
 * The one way a supervisor takes the session: two started together — the startup
 * hook and the reopen action — must not both win, since each closes every other
 * supervisor pane on start and they would close each other's.
 */
export async function claimPid(stateDir: string, info: SupervisorPid): Promise<boolean> {
  return writeJsonExclusive(pidPath(stateDir, info.session), info)
}

/** Removes the pid file only if it still names `stale`, so a file a rival just claimed survives. */
export function clearStalePid(stateDir: string, session: SessionKey, stale: SupervisorPid): void {
  removeJsonIf(pidPath(stateDir, session), (current) => {
    const info = current as Partial<SupervisorPid> | null
    return info?.pid === stale.pid && info.started_at_ms === stale.started_at_ms
  })
}

export async function readPid(
  stateDir: string, session: SessionKey,
): Promise<SupervisorPid | null> {
  return readJson<SupervisorPid>(pidPath(stateDir, session))
}

export function clearPid(stateDir: string, session: SessionKey): void {
  try {
    unlinkSync(pidPath(stateDir, session))
  } catch {
    // Already gone.
  }
}

export async function supervisorState(
  stateDir: string, session: SessionKey,
): Promise<SupervisorState> {
  const info = await readPid(stateDir, session)
  if (!info) return { state: 'none' }

  const startedAt = await processStartedAtMs(info.pid)
  if (startedAt === null) return { state: 'stale', info }

  // Allow a second of slop: `ps` reports whole seconds.
  if (Math.abs(startedAt - info.started_at_ms) > 1_000) return { state: 'stale', info }
  return { state: 'live', info }
}
