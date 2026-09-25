import { join } from 'node:path'
import { enqueue } from '../lib/queue'
import { sessionKey } from '../lib/session'
import type { AgentStatus, EventKind, QueuedEvent } from '../lib/types'

interface RawEvent {
  pane_id?: string
  workspace_id?: string
  agent_status?: AgentStatus
  released?: boolean
  workspace?: {
    workspace_id?: string
    worktree?: { repo_key?: string; repo_root?: string; is_linked_worktree?: boolean } | null
  }
  worktree?: { branch?: string | null; path?: string }
}

/** Returns null when the payload carries nothing actionable. */
export function toQueuedEvent(
  kind: EventKind, session: string, rawJson: string,
): QueuedEvent | null {
  let raw: RawEvent
  try {
    const parsed: unknown = JSON.parse(rawJson)
    // `JSON.parse("null")` succeeds and returns null, so guarding the parse
    // alone is not enough — reading a field off it would throw out of a hook.
    if (parsed === null || typeof parsed !== 'object') return null
    // herdr wraps every payload as {event, data:{...}} — measured live on 0.9.0.
    // Reading the fields off the envelope yields undefined for all of them, which
    // enqueues a bare {kind, session, at} that matches no task and binds nothing.
    const envelope = parsed as { data?: unknown }
    raw = (envelope.data !== null && typeof envelope.data === 'object'
      ? envelope.data
      : parsed) as RawEvent
  } catch {
    return null
  }

  const event: QueuedEvent = { kind, session, at: Date.now() }

  if (raw.pane_id) event.pane_id = raw.pane_id
  if (raw.agent_status) event.agent_status = raw.agent_status
  if (raw.released !== undefined) event.released = raw.released
  event.workspace_id = raw.workspace?.workspace_id ?? raw.workspace_id

  const provenance = raw.workspace?.worktree
  if (provenance) {
    if (provenance.repo_key) event.repo_key = provenance.repo_key
    if (provenance.repo_root) event.repo_root = provenance.repo_root
    if (provenance.is_linked_worktree !== undefined) {
      event.is_linked_worktree = provenance.is_linked_worktree
    }
  }

  if (raw.worktree?.branch) event.branch = raw.worktree.branch
  if (raw.worktree?.path) event.checkout_path = raw.worktree.path

  return event
}

export async function runHook(
  kind: EventKind, queueDir: string, session: string, rawJson: string,
): Promise<void> {
  const event = toQueuedEvent(kind, session, rawJson)
  if (!event) {
    // A queue entry with no fields is indistinguishable from a legitimately
    // sparse event, so the supervisor could not act on it either way. Report
    // and drop rather than enqueue something unactionable.
    console.error(`[pipeline] ${kind}: unparseable event payload, dropped`)
    return
  }
  await enqueue(queueDir, event)
}

/** Entrypoint shared by every hook script. Parses env, enqueues, exits. */
export async function main(kind: EventKind): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  if (!stateDir) process.exit(0)
  const session = sessionKey()
  await runHook(kind, join(stateDir, 'queue', session), session, process.env.HERDR_PLUGIN_EVENT_JSON ?? '')
}
