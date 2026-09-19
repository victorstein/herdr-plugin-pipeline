import { dirname } from 'node:path'

async function gitOut(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'ignore' })
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
export async function repoContext(): Promise<{ repoKey: string; repoRoot: string } | null> {
  const toplevel = await gitOut(['rev-parse', '--show-toplevel'])
  if (toplevel.length === 0) return null

  const gitDir = await gitOut(['rev-parse', '--path-format=absolute', '--git-dir'])
  const commonDir = await gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const root = commonDir.length > 0 && gitDir !== commonDir ? dirname(commonDir) : toplevel
  return { repoKey: root, repoRoot: root }
}
