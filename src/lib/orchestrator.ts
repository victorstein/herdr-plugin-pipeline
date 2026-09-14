import type { Herdr } from './herdr'
import { readOrchestrator } from './ledger'
import type { SessionKey } from './types'

export async function resolveOrchestrator(
  stateDir: string, herdr: Herdr, session: SessionKey, repoKey: string,
): Promise<string | null> {
  const claimed = await readOrchestrator(stateDir, session, repoKey)
  if (claimed) {
    const panes = await herdr.paneList(claimed.workspace_id)
    if (panes.some((p) => p.pane_id === claimed.pane_id)) return claimed.pane_id
  }

  const workspaces = await herdr.workspaceList()
  const primary = workspaces.find(
    (w) => w.worktree?.repo_key === repoKey && w.worktree.is_linked_worktree === false,
  )
  if (!primary) return null

  const panes = await herdr.paneList(primary.workspace_id)
  const agentPane = panes.find((p) => p.agent_status !== undefined && p.agent_status !== 'unknown')
  return agentPane?.pane_id ?? null
}
