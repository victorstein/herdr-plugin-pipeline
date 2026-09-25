import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  baseLine, dependencyMerges, describeBase, forgetDispatchBases, freshDispatchBase, mainlineBranch,
} from '../src/lib/dispatch-base'
import type { Task } from '../src/lib/types'
import {
  cleanupFixtures, cloneOfRemote, git, landOnRemote, pushedFromLocal, repoWithWorktree, revParse, tempDir,
} from './helpers/git-worktree'

afterEach(() => {
  forgetDispatchBases()
  cleanupFixtures()
})

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
  const { remote, local } = pushedFromLocal('master')
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

  expect((await freshDispatchBase(clone, [], now)).commit).toBe(first)
  const merged = landOnRemote(remote, 'main')
  clock += 30_000
  expect((await freshDispatchBase(clone, [], now)).commit).toBe(first)
  clock += 31_000
  expect((await freshDispatchBase(clone, [], now)).commit).toBe(merged)
})

// The clock does not move at all: a merge landing in the same second as the
// cached fetch is exactly what a mergedAt comparison could not see.
test('a cached fetch that lacks a dependency merge is not reused, even within the same second', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const now = () => 1_000_000

  await freshDispatchBase(clone, [], now)
  const merged = landOnRemote(remote, 'main')
  expect((await freshDispatchBase(clone, [merged], now)).commit).toBe(merged)
})

test('a cached fetch that already contains the dependency merge is reused', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const merged = landOnRemote(remote, 'main')
  const now = () => 1_000_000

  expect((await freshDispatchBase(clone, [merged], now)).commit).toBe(merged)
  const later = landOnRemote(remote, 'main')
  expect((await freshDispatchBase(clone, [merged], now)).commit).toBe(merged)
  expect(later).not.toBe(merged)
})

test('a dependency merged with no merge commit on record always fetches', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const now = () => 1_000_000

  await freshDispatchBase(clone, [], now)
  const merged = landOnRemote(remote, 'main')
  expect((await freshDispatchBase(clone, null, now)).commit).toBe(merged)
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

/** Points origin at a fake ssh that logs each connection and fails, so network calls can be counted. */
function remoteCountingCalls(local: string): () => number {
  const ssh = fakeSsh()
  git(['remote', 'set-url', 'origin', 'ssh://git@example.invalid/repo.git'], local)
  git(['config', 'core.sshCommand', join(ssh.dir, 'ssh')], local)
  return () => existsSync(ssh.log) ? readFileSync(ssh.log, 'utf8').split('\n').filter(Boolean).length : 0
}

function worktreeOf(primary: string): string {
  const worktree = join(tempDir('hpipe-wt-'), 'wt')
  git(['worktree', 'add', '-q', '-b', 'feat/x', worktree, 'HEAD'], primary)
  return worktree
}

test('a default dispatch learned from the main checkout answers a worktree without asking the remote', async () => {
  const { local } = pushedFromLocal('master')
  const worktree = worktreeOf(local)
  expect((await freshDispatchBase(local)).ref).toBe('origin/master')
  const networkCalls = remoteCountingCalls(local)

  expect(await mainlineBranch(worktree)).toBe('master')
  expect(networkCalls()).toBe(0)
})

test('a failed default-branch lookup is not retried, from any worktree, until the cache expires', async () => {
  const { local } = pushedFromLocal('master')
  const worktree = worktreeOf(local)
  const networkCalls = remoteCountingCalls(local)
  const failures: string[] = []
  const onFailure = (reason: string) => { failures.push(reason) }
  let clock = 1_000_000
  const now = () => clock

  expect(await mainlineBranch(local, onFailure, now)).toBeNull()
  expect(networkCalls()).toBe(1)
  expect(failures).toHaveLength(1)

  clock += 59_000
  expect(await mainlineBranch(worktree, onFailure, now)).toBeNull()
  expect(networkCalls()).toBe(1)
  expect(failures).toHaveLength(1)

  clock += 2_000
  expect(await mainlineBranch(worktree, onFailure, now)).toBeNull()
  expect(networkCalls()).toBe(2)
  expect(failures).toHaveLength(2)
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

test('a base must contain every dependency merge commit, and an unrecorded one forces a fetch', () => {
  const task = (over: Partial<Task>) => ({ task_id: 't', depends_on: [], merged_at_ms: null, ...over }) as Task
  const tasks = [
    task({ task_id: 't1', merged_at_ms: 100, merge_commit: 'aaa' }),
    task({ task_id: 't2', merged_at_ms: 300, merge_commit: 'bbb' }),
    task({ task_id: 't3', merged_at_ms: 900 }),
  ]
  expect(dependencyMerges(task({ task_id: 't4', depends_on: ['t1', 't2'] }), tasks)).toEqual(['aaa', 'bbb'])
  expect(dependencyMerges(task({ task_id: 't5' }), tasks)).toEqual([])
  expect(dependencyMerges(task({ task_id: 't6', depends_on: ['t1', 't3'] }), tasks)).toBeNull()
})
