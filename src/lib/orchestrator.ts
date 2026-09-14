import type { Herdr } from './herdr'
import { readOrchestrator } from './ledger'
import type { Run, SessionKey } from './types'

export async function resolveOrchestrator(
  stateDir: string, herdr: Herdr, session: SessionKey, repoRoot: string,
): Promise<string | null> {
  const claimed = await readOrchestrator(stateDir, session, repoRoot)
  if (claimed) {
    const panes = await herdr.paneList(claimed.workspace_id)
    if (panes.some((p) => p.pane_id === claimed.pane_id)) return claimed.pane_id
  }

  // herdr's repo_key is an opaque herdr identifier; run records key off the git
  // toplevel path. repo_root is the only value both sides agree on.
  const workspaces = await herdr.workspaceList()
  const primary = workspaces.find(
    (w) => w.worktree?.repo_root === repoRoot && w.worktree.is_linked_worktree === false,
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

/**
 * Re-points a run at a live orchestrator pane when its recorded one has gone.
 * herdr restores a pane under a new id, so without this a run keeps prompting a
 * pane that no longer exists until the retry budget runs out, then goes quiet.
 *
 * Returns whether the run was changed. A run whose orchestrator cannot be
 * resolved keeps its stale id on purpose — clearing it would lose the
 * diagnostic `hpipe status` prints.
 */
export async function rebindOrchestrator(
  stateDir: string, herdr: Herdr, session: SessionKey, run: Run,
): Promise<boolean> {
  if (run.orchestrator_pane) {
    const panes = await herdr.paneList()
    if (panes.some((p) => p.pane_id === run.orchestrator_pane)) return false
  }

  const resolved = await resolveOrchestrator(stateDir, herdr, session, run.repo_root)
  if (!resolved || resolved === run.orchestrator_pane) return false

  const previous = run.orchestrator_pane ?? 'none'
  run.orchestrator_pane = resolved
  run.history.push({
    at: Date.now(), from: previous, to: resolved,
    why: `orchestrator rebound after ${previous} went away`,
  })
  return true
}
