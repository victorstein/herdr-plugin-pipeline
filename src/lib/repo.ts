import { dirname } from 'node:path'

async function gitOut(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
  const out = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  return out
}

/**
 * The repository a run is keyed by. Inside a linked worktree `--show-toplevel`
 * is the worktree, which never equals the run's `repo_key`, so the shared
 * `--git-common-dir` is used there. The two forms differ *only* in a worktree —
 * inside a submodule they are equal and `dirname(--git-common-dir)` would be
 * `<super>/.git/modules`, which is not a repository.
 */
export async function repoContext(cwd?: string): Promise<{ repoKey: string; repoRoot: string } | null> {
  const toplevel = await gitOut(['rev-parse', '--show-toplevel'], cwd)
  if (toplevel.length === 0) return null

  const gitDir = await gitOut(['rev-parse', '--path-format=absolute', '--git-dir'], cwd)
  const commonDir = await gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  const root = commonDir.length > 0 && gitDir !== commonDir ? dirname(commonDir) : toplevel
  return { repoKey: root, repoRoot: root }
}

/**
 * herdr runs a plugin action from the plugin's own root, which a GitHub install
 * makes a git checkout of its own, so the action's cwd names the plugin's repo.
 * The pane the human is in arrives in the context herdr hands every action. Its
 * `worktree.repo_key` is the `.git` path, so the root is read rather than the key.
 */
export function focusedCwd(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.HERDR_PLUGIN_CONTEXT_JSON
  if (raw === undefined) return null
  try {
    const context = JSON.parse(raw) as { focused_pane_cwd?: unknown; worktree?: { repo_root?: unknown } }
    const root = context.worktree?.repo_root ?? context.focused_pane_cwd
    return typeof root === 'string' && root.length > 0 ? root : null
  } catch {
    return null
  }
}

/** The repo of the pane an action was invoked from; never the plugin's own checkout. */
export async function actionRepoContext(
  env: Record<string, string | undefined> = process.env,
): Promise<{ repoKey: string; repoRoot: string } | null> {
  const cwd = focusedCwd(env)
  return cwd === null ? null : repoContext(cwd)
}
