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
  const agentPanes = panes.filter(
    (p) => p.agent_status !== undefined && p.agent_status !== 'unknown',
  )

  // Ambiguity is not resolved by guessing. Pane list order is not documented as
  // meaningful, and picking wrong types a long prompt into an unrelated agent.
  // Explicit `claim` is the disambiguator, so force it.
  if (agentPanes.length !== 1) return null
  return agentPanes[0]?.pane_id ?? null
}
