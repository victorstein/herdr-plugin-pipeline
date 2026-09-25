import { join } from 'node:path'
import { type PaneInfo, paneHasNoAgent } from './herdr'
import type { PaneObservations } from './outbox'
import { readJson, writeJson } from './store'
import type { SessionKey } from './types'

/** Why the supervisor is holding what it owes one pane. */
export interface PaneHold {
  /** Start of the current streak of failed or held sends. */
  since: number
  failures: number
  /** The last herdr code, or `stuck_input` while the box holds text the supervisor did not write. */
  code: string
}

/**
 * The supervisor's delivery gate as `hpipe status` sees it. The gate lives in the
 * supervisor's memory, and decision prompts, answers and stall probes are not in
 * the outbox, so without this file status cannot say why any of them is held.
 */
export interface DeliveryHealth {
  pid: number
  written_at: number
  panes: Record<string, PaneHold>
}

const healthPath = (stateDir: string, session: SessionKey) =>
  join(stateDir, `delivery.${session}.json`)

export async function writeDeliveryHealth(
  stateDir: string, session: SessionKey, health: DeliveryHealth,
): Promise<void> {
  await writeJson(healthPath(stateDir, session), health)
}

/** How often the supervisor rewrites the file even when nothing in it changed. */
export const HEALTH_REFRESH_MS = 15_000

/**
 * Several refreshes: older than this, the supervisor is alive but not ticking —
 * wedged in a slow call — and its holds describe a moment long gone.
 */
export const HEALTH_MAX_AGE_MS = 4 * HEALTH_REFRESH_MS

/** Only the live, ticking supervisor's file counts. */
export async function readPaneHolds(
  stateDir: string, session: SessionKey, livePid: number | undefined, now: number = Date.now(),
): Promise<Record<string, PaneHold>> {
  if (livePid === undefined) return {}
  const health = await readJson<DeliveryHealth>(healthPath(stateDir, session))
  if (health?.pid !== livePid || now - health.written_at > HEALTH_MAX_AGE_MS) return {}
  return health.panes
}

/** Everything `hpipe status` needs to know about the panes, from one pane list. */
export async function observePanes(
  paneList: () => Promise<PaneInfo[]>, stateDir: string, session: SessionKey,
  livePid: number | undefined,
): Promise<{ livePanes: Set<string>; panes: PaneObservations }> {
  const listed = await paneList()
  return {
    livePanes: new Set(listed.map((p) => p.pane_id)),
    panes: {
      agentless: new Set(listed.filter(paneHasNoAgent).map((p) => p.pane_id)),
      holds: await readPaneHolds(stateDir, session, livePid),
    },
  }
}
