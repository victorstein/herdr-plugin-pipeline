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

export const revParse = (cwd: string, ref: string): string =>
  Bun.spawnSync(['git', '-C', cwd, 'rev-parse', ref], { stdout: 'pipe' }).stdout.toString().trim()

export function commitAs(checkout: string, rel: string, body: string): void {
  git(['config', 'user.email', 'test@example.com'], checkout)
  git(['config', 'user.name', 'Test'], checkout)
  commitIn(checkout, rel, body)
}

export function bareRemote(defaultBranch: string): string {
  const remote = tempDir('hpipe-remote-')
  git(['init', '-q', '--bare', `--initial-branch=${defaultBranch}`, '.'], remote)
  const seed = join(tempDir('hpipe-seed-'), 'seed')
  git(['clone', '-q', remote, seed], tempDir('hpipe-cwd-'))
  commitAs(seed, 'README.md', 'scaffold\n')
  git(['push', '-q', 'origin', `HEAD:${defaultBranch}`], seed)
  return remote
}

/** A real clone, so `refs/remotes/origin/HEAD` names the remote's default branch. */
export function cloneOfRemote(defaultBranch: string): { remote: string; clone: string } {
  const remote = bareRemote(defaultBranch)
  const clone = join(tempDir('hpipe-clone-'), 'clone')
  git(['clone', '-q', remote, clone], tempDir('hpipe-cwd-'))
  return { remote, clone }
}

let landings = 0
/** Another clone pushes one commit to `branch`, as a merged sibling PR would. Returns its sha. */
export function landOnRemote(remote: string, branch: string, rel = `src/landed-${++landings}.ts`): string {
  const sibling = join(tempDir('hpipe-landing-'), 'sib')
  git(['clone', '-q', remote, sibling], tempDir('hpipe-cwd-'))
  commitAs(sibling, rel, 'sibling-owned\n')
  git(['push', '-q', 'origin', `HEAD:${branch}`], sibling)
  return revParse(sibling, 'HEAD')
}
