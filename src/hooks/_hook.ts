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

export function toQueuedEvent(kind: EventKind, session: string, rawJson: string): QueuedEvent {
  const event: QueuedEvent = { kind, session, at: Date.now() }

  let raw: RawEvent
  try {
    raw = JSON.parse(rawJson) as RawEvent
  } catch {
    return event
  }

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
  await enqueue(queueDir, toQueuedEvent(kind, session, rawJson))
}

/** Entrypoint shared by all five hook scripts. Parses env, enqueues, exits. */
export async function main(kind: EventKind): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  if (!stateDir) process.exit(0)
  await runHook(kind, join(stateDir, 'queue'), sessionKey(), process.env.HERDR_PLUGIN_EVENT_JSON ?? '')
}
