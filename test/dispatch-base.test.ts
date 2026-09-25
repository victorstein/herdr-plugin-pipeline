import { afterEach, expect, test } from 'bun:test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  baseLine, dependenciesMergedAt, describeBase, forgetDispatchBases, freshDispatchBase,
} from '../src/lib/dispatch-base'
import type { Task } from '../src/lib/types'
import { cleanupFixtures, commitIn, git, repoWithWorktree, tempDir } from './helpers/git-worktree'

afterEach(() => {
  forgetDispatchBases()
  cleanupFixtures()
})

const revParse = (cwd: string, ref: string): string =>
  Bun.spawnSync(['git', '-C', cwd, 'rev-parse', ref], { stdout: 'pipe' }).stdout.toString().trim()

function commitAs(checkout: string, rel: string, body: string): void {
  git(['config', 'user.email', 'test@example.com'], checkout)
  git(['config', 'user.name', 'Test'], checkout)
  commitIn(checkout, rel, body)
}

function bareRemote(defaultBranch: string): string {
  const remote = tempDir('hpipe-remote-')
  git(['init', '-q', '--bare', `--initial-branch=${defaultBranch}`, '.'], remote)
  const seed = join(tempDir('hpipe-seed-'), 'seed')
  git(['clone', '-q', remote, seed], tempDir('hpipe-cwd-'))
  commitAs(seed, 'README.md', 'scaffold\n')
  git(['push', '-q', 'origin', `HEAD:${defaultBranch}`], seed)
  return remote
}

function cloneOfRemote(defaultBranch: string): { remote: string; clone: string } {
  const remote = bareRemote(defaultBranch)
  const clone = join(tempDir('hpipe-clone-'), 'clone')
  git(['clone', '-q', remote, clone], tempDir('hpipe-cwd-'))
  return { remote, clone }
}

let landings = 0
function landOnRemote(remote: string, branch: string): string {
  const sibling = join(tempDir('hpipe-landing-'), 'sib')
  git(['clone', '-q', remote, sibling], tempDir('hpipe-cwd-'))
  commitAs(sibling, `src/landed-${++landings}.ts`, 'export const farewell = 1\n')
  git(['push', '-q', 'origin', `HEAD:${branch}`], sibling)
  return revParse(sibling, 'HEAD')
}

test('a dependency merged upstream is in the base though local main is stale', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const staleMain = revParse(clone, 'main')
  const merged = landOnRemote(remote, 'main')

  expect(await freshDispatchBase(clone)).toEqual({ commit: merged, ref: 'origin/main', fetchError: null })
  expect(revParse(clone, 'main')).toBe(staleMain)
})

test('the remote default branch is followed rather than assumed to be main', async () => {
  const { remote, clone } = cloneOfRemote('trunk')
  const merged = landOnRemote(remote, 'trunk')

  expect(await freshDispatchBase(clone)).toEqual({ commit: merged, ref: 'origin/trunk', fetchError: null })
})

test('a repo created locally and pushed has no origin/HEAD, so the remote is asked for its default', async () => {
  const remote = bareRemote('master')
  const local = tempDir('hpipe-local-')
  git(['init', '-q', '--initial-branch=master', '.'], local)
  git(['remote', 'add', 'origin', remote], local)
  git(['fetch', '-q', 'origin'], local)
  const merged = landOnRemote(remote, 'master')

  expect(await freshDispatchBase(local)).toEqual({ commit: merged, ref: 'origin/master', fetchError: null })
})

test('an unreachable remote keeps the last-fetched commit and says it may be stale', async () => {
  const { clone } = cloneOfRemote('main')
  const lastFetched = revParse(clone, 'origin/main')
  git(['remote', 'set-url', 'origin', join(tempDir('hpipe-gone-'), 'missing.git')], clone)

  const base = await freshDispatchBase(clone)
  expect(base.commit).toBe(lastFetched)
  expect(base.ref).toBe('origin/main')
  expect(base.fetchError).not.toBeNull()
  expect(describeBase(base)).toStartWith('fetch failed: ')
  expect(describeBase(base)).toEndWith('; local origin/main, may be stale')
})

test('a repo with no remote falls back to local main and does not claim a fetch', async () => {
  const worktree = repoWithWorktree(['README.md'])
  const base = await freshDispatchBase(worktree)
  expect(base.commit).toBe(revParse(worktree, 'main'))
  expect(base.ref).toBe('main')
  expect(base.fetchError).toContain('origin')
})

test('no commit is named when no base resolves', async () => {
  const base = await freshDispatchBase(tempDir('hpipe-nogit-'))
  expect(base.commit).toBeNull()
  expect(base.ref).toBe('main')
})

test('a burst of dispatches shares one fetch until it expires', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const first = revParse(clone, 'origin/main')
  let clock = 1_000_000
  const now = () => clock

  expect((await freshDispatchBase(clone, 0, now)).commit).toBe(first)
  const merged = landOnRemote(remote, 'main')
  clock += 30_000
  expect((await freshDispatchBase(clone, 0, now)).commit).toBe(first)
  clock += 31_000
  expect((await freshDispatchBase(clone, 0, now)).commit).toBe(merged)
})

test('a fetch older than the dependency merge is not reused', async () => {
  const { remote, clone } = cloneOfRemote('main')
  let clock = 1_000_000
  const now = () => clock

  await freshDispatchBase(clone, 0, now)
  const merged = landOnRemote(remote, 'main')
  clock += 1_000
  expect((await freshDispatchBase(clone, clock - 500, now)).commit).toBe(merged)
})

function fakeSsh(): { dir: string; log: string } {
  const dir = tempDir('hpipe-fakessh-')
  const log = join(dir, 'argv.log')
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\necho "$@" >> ${log}\nexit 255\n`)
  chmodSync(join(dir, 'ssh'), 0o755)
  return { dir, log }
}

async function withPath<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH }
  process.env.PATH = `${dir}:${saved.PATH}`
  delete process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('ssh runs in batch mode, so it fails rather than prompts', async () => {
  const { clone } = cloneOfRemote('main')
  git(['remote', 'set-url', 'origin', 'ssh://git@example.invalid/repo.git'], clone)
  const ssh = fakeSsh()

  const base = await withPath(ssh.dir, () => freshDispatchBase(clone))
  expect(base.fetchError).not.toBeNull()
  expect(readFileSync(ssh.log, 'utf8')).toContain('BatchMode=yes')
})

test('a user-configured core.sshCommand is left alone', async () => {
  const { clone } = cloneOfRemote('main')
  git(['remote', 'set-url', 'origin', 'ssh://git@example.invalid/repo.git'], clone)
  const ssh = fakeSsh()
  git(['config', 'core.sshCommand', `${join(ssh.dir, 'ssh')} -o UserChoice=yes`], clone)

  await withPath(tempDir('hpipe-emptypath-'), () => freshDispatchBase(clone))
  const argv = readFileSync(ssh.log, 'utf8')
  expect(argv).toContain('UserChoice=yes')
  expect(argv).not.toContain('BatchMode=yes')
})

test('a branch cut from a commit tracks nothing, so a bare push cannot target main', () => {
  const primary = repoWithWorktree(['README.md'])
  git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main'], primary)
  const worktree = join(tempDir('hpipe-shacut-'), 'wt')
  git(['worktree', 'add', '-q', '-b', 'feat/dependent', worktree, revParse(primary, 'origin/main')], primary)

  const upstream = Bun.spawnSync(['git', '-C', worktree, 'rev-parse', '--abbrev-ref', '@{u}'], { stderr: 'pipe' })
  expect(upstream.exitCode).not.toBe(0)
})

test('the base line names the commit and whether it was just fetched', () => {
  expect(baseLine({ commit: '1fb8a43', ref: 'origin/main', fetchError: null }))
    .toBe('base: 1fb8a43 (origin/main as just fetched)')
  expect(baseLine({ commit: '1fb8a43', ref: 'origin/main', fetchError: 'timed out after 15s' }))
    .toBe('base: 1fb8a43 (fetch failed: timed out after 15s; local origin/main, may be stale)')
  expect(baseLine({ commit: null, ref: 'main', fetchError: 'not a git repository' }))
    .toBe('base: main (fetch failed: not a git repository; local main, may be stale)')
})

test('a task is fresh only after its newest dependency merged', () => {
  const task = (over: Partial<Task>) => ({ task_id: 't', depends_on: [], merged_at_ms: null, ...over }) as Task
  const tasks = [
    task({ task_id: 't1', merged_at_ms: 100 }),
    task({ task_id: 't2', merged_at_ms: 300 }),
    task({ task_id: 't3', merged_at_ms: 900 }),
  ]
  expect(dependenciesMergedAt(task({ task_id: 't4', depends_on: ['t1', 't2'] }), tasks)).toBe(300)
  expect(dependenciesMergedAt(task({ task_id: 't5' }), tasks)).toBe(0)
})
