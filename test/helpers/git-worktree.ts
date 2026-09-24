import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const created: string[] = []

export function git(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' })
  if (!proc.success) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`)
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/**
 * A REAL git worktree, not a temp directory. `git worktree add` stamps every file
 * it checks out with the current mtime, which is the precondition that makes an
 * mtime-based artifact scan useless in `research`; a fixture without it cannot
 * detect that class of bug.
 */
export function repoWithWorktree(preExisting: string[], repoConfig: string[][] = []): string {
  const repo = tempDir('hpipe-repo-')
  git(['init', '-q', '--initial-branch=main', '.'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  for (const pair of repoConfig) git(['config', ...pair], repo)
  for (const rel of preExisting) {
    mkdirSync(join(repo, dirname(rel)), { recursive: true })
    writeFileSync(join(repo, rel), `pre-existing ${rel}\n`)
  }
  git(['add', '-A'], repo)
  git(['commit', '-qm', 'base'], repo)
  const worktree = join(tempDir('hpipe-wt-'), 'wt')
  git(['worktree', 'add', '-q', '-b', 'feat/x', worktree], repo)
  return worktree
}

export function commitIn(worktree: string, rel: string, body: string): void {
  mkdirSync(join(worktree, dirname(rel)), { recursive: true })
  writeFileSync(join(worktree, rel), body)
  git(['add', '-A'], worktree)
  git(['commit', '-qm', `add ${rel}`], worktree)
}

/** Each fixture is a real repo plus a registered linked worktree; none of it is self-cleaning. */
export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * Commits `rel` on a sibling branch cut from `main`, as another task's PR would,
 * and moves `landsAt` to it. `origin/main` leaves local `main` stale, which is
 * what a worker merging `origin/main` without updating `main` sees; `sibling`
 * moves no mainline ref at all. Returns the ref to merge.
 */
export function siblingLands(
  worktree: string, rel: string, landsAt: 'main' | 'origin/main' | 'sibling',
): string {
  const sibling = join(tempDir('hpipe-sib-'), 'wt')
  git(['worktree', 'add', '-q', '-b', 'sibling', sibling, 'main'], worktree)
  commitIn(sibling, rel, 'sibling-owned\n')
  if (landsAt === 'main') git(['update-ref', 'refs/heads/main', 'refs/heads/sibling'], worktree)
  if (landsAt === 'origin/main') {
    git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/sibling'], worktree)
  }
  return landsAt
}
