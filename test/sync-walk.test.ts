import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nothingToLand, syncWalk } from '../src/lib/sync-walk'
import { cleanupFixtures, git, revParse, tempDir } from './helpers/git-worktree'

afterEach(cleanupFixtures)

/**
 * A repo with a `batch` branch and a task branch `t` cut from it, each with one
 * commit of its own, in the shape the clean-sync predicate was probed on.
 */
function forked(): { repo: string; landSha: string } {
  const repo = tempDir('hpipe-walk-')
  git(['init', '-q', '--initial-branch=batch', '.'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  write(repo, 'shared.txt', 'one\ntwo\nthree\n')
  commit(repo, 'base')
  git(['checkout', '-q', '-b', 't'], repo)
  write(repo, 'task.txt', 'task work\n')
  commit(repo, 'feat: task work')
  const landSha = revParse(repo, 'HEAD')
  git(['checkout', '-q', 'batch'], repo)
  write(repo, 'sibling.txt', 'sibling work\n')
  commit(repo, 'feat: sibling landed')
  git(['checkout', '-q', 't'], repo)
  return { repo, landSha }
}

function write(repo: string, rel: string, body: string): void {
  writeFileSync(join(repo, rel), body)
}

function commit(repo: string, message: string): void {
  git(['add', '-A'], repo)
  git(['commit', '-qm', message], repo)
}

function onBatch(repo: string, rel: string, body: string): void {
  git(['checkout', '-q', 'batch'], repo)
  write(repo, rel, body)
  commit(repo, `batch: ${rel}`)
  git(['checkout', '-q', 't'], repo)
}

const merge = (repo: string, ...args: string[]) => git(['merge', '-q', '--no-edit', ...args], repo)

const walk = (repo: string, landSha: string) => syncWalk(repo, landSha, 'batch')

/** Leaves a conflict for the caller to resolve, the way a worker meets one. */
function conflicting(repo: string): void {
  onBatch(repo, 'shared.txt', 'one\nBATCH\nthree\n')
  write(repo, 'shared.txt', 'one\nTASK\nthree\n')
  commit(repo, 'feat: task edits shared')
}

function mergeExpectingConflict(repo: string, ...args: string[]): void {
  Bun.spawnSync(['git', 'merge', '-q', '--no-edit', ...args, 'batch'], { cwd: repo, stdout: 'ignore', stderr: 'ignore' })
}

test('one honest merge of the batch is clean', async () => {
  const { repo, landSha } = forked()
  merge(repo, 'batch')
  expect(await walk(repo, landSha)).toEqual({ clean: true })
})

test('two honest merges are clean', async () => {
  const { repo, landSha } = forked()
  merge(repo, 'batch')
  onBatch(repo, 'later.txt', 'later\n')
  merge(repo, 'batch')
  expect(await walk(repo, landSha)).toEqual({ clean: true })
})

test('nothing to merge is trivially clean: HEAD is the reviewed head', async () => {
  const { repo, landSha } = forked()
  expect(await walk(repo, landSha)).toEqual({ clean: true })
})

test('both sides making the identical change merge clean', async () => {
  const { repo, landSha } = forked()
  onBatch(repo, 'shared.txt', 'one\nSAME\nthree\n')
  git(['reset', '-q', '--hard', landSha], repo)
  write(repo, 'shared.txt', 'one\nSAME\nthree\n')
  commit(repo, 'feat: same change')
  const reviewed = revParse(repo, 'HEAD')
  merge(repo, 'batch')
  expect(await walk(repo, reviewed)).toEqual({ clean: true })
})

test('-X theirs with no conflict to apply it to is clean', async () => {
  const { repo, landSha } = forked()
  merge(repo, '-X', 'theirs', 'batch')
  expect(await walk(repo, landSha)).toEqual({ clean: true })
})

test('an extra commit after the merge is dirty, and named', async () => {
  const { repo, landSha } = forked()
  merge(repo, 'batch')
  write(repo, 'extra.txt', 'extra\n')
  commit(repo, 'fix: extra')
  const extra = revParse(repo, 'HEAD')
  expect(await walk(repo, landSha)).toEqual({ clean: false, at: extra, why: 'not a merge' })
})

test('an extra commit before the merge is dirty', async () => {
  const { repo, landSha } = forked()
  write(repo, 'extra.txt', 'extra\n')
  commit(repo, 'fix: extra')
  const extra = revParse(repo, 'HEAD')
  merge(repo, 'batch')
  expect(await walk(repo, landSha)).toMatchObject({ clean: false, at: extra })
})

test('an edit amended into the merge is dirty: its tree is not the automatic merge', async () => {
  const { repo, landSha } = forked()
  merge(repo, 'batch')
  write(repo, 'task.txt', 'edited inside the merge\n')
  git(['commit', '-q', '-a', '--amend', '--no-edit'], repo)
  expect(await walk(repo, landSha)).toEqual({
    clean: false, at: revParse(repo, 'HEAD'), why: 'its tree is not the automatic merge of its parents',
  })
})

test('a hand-resolved conflict is dirty, whichever way it was resolved', async () => {
  for (const resolution of ['one\nRESOLVED\nthree\n', 'one\nBATCH\nthree\n', 'one\nTASK\nthree\n']) {
    const { repo } = forked()
    conflicting(repo)
    const reviewed = revParse(repo, 'HEAD')
    mergeExpectingConflict(repo)
    write(repo, 'shared.txt', resolution)
    commit(repo, 'merge batch')
    expect(await walk(repo, reviewed), resolution).toMatchObject({
      clean: false, why: 'the automatic merge of its parents conflicts',
    })
  }
})

test('conflict markers committed are dirty', async () => {
  const { repo } = forked()
  conflicting(repo)
  const reviewed = revParse(repo, 'HEAD')
  mergeExpectingConflict(repo)
  commit(repo, 'merge batch, markers and all')
  expect(await walk(repo, reviewed)).toMatchObject({ clean: false })
})

test('-X theirs over a real conflict, and -s ours, are dirty', async () => {
  for (const strategy of [['-X', 'theirs'], ['-s', 'ours']]) {
    const { repo } = forked()
    conflicting(repo)
    const reviewed = revParse(repo, 'HEAD')
    merge(repo, ...strategy, 'batch')
    expect(await walk(repo, reviewed), strategy.join(' ')).toMatchObject({ clean: false })
  }
})

test('a rebase onto the batch is dirty: the walk reaches the batch without meeting the reviewed head', async () => {
  const { repo, landSha } = forked()
  git(['rebase', '-q', 'batch'], repo)
  expect(await walk(repo, landSha)).toMatchObject({ clean: false })
})

test('an unrelated commit brought in through a side merge is dirty', async () => {
  const { repo, landSha } = forked()
  git(['checkout', '-q', '-b', 'side', 'batch'], repo)
  write(repo, 'side.txt', 'unreviewed\n')
  commit(repo, 'feat: side')
  git(['checkout', '-q', 't'], repo)
  merge(repo, 'side')
  expect(await walk(repo, landSha)).toEqual({
    clean: false, at: revParse(repo, 'HEAD'), why: 'its second parent is not on the batch branch',
  })
})

test('merging from the batch plus one commit is dirty', async () => {
  const { repo, landSha } = forked()
  git(['checkout', '-q', '-b', 'batch-plus', 'batch'], repo)
  write(repo, 'plus.txt', 'plus\n')
  commit(repo, 'feat: plus')
  git(['checkout', '-q', 't'], repo)
  merge(repo, 'batch-plus')
  expect(await walk(repo, landSha)).toMatchObject({ clean: false })
})

test('a reverse merge, with the batch as first parent, is dirty', async () => {
  const { repo, landSha } = forked()
  git(['checkout', '-q', '--detach', 'batch'], repo)
  merge(repo, landSha)
  git(['branch', '-q', '-f', 't', 'HEAD'], repo)
  git(['checkout', '-q', 't'], repo)
  expect(await walk(repo, landSha)).toMatchObject({ clean: false })
})

/**
 * A criss-cross: the batch takes the task's commit through a merge of its own
 * while the task merges the batch, so the next sync has two merge bases.
 */
function crissCross(agreeing: boolean): { repo: string; reviewed: string } {
  const { repo } = forked()
  conflicting(repo)
  const taskCommit = revParse(repo, 'HEAD')
  mergeExpectingConflict(repo)
  write(repo, 'shared.txt', 'one\nRESOLVED\nthree\n')
  commit(repo, 'merge batch into t')
  const reviewed = revParse(repo, 'HEAD')
  git(['checkout', '-q', 'batch'], repo)
  Bun.spawnSync(['git', 'merge', '-q', '--no-edit', taskCommit], { cwd: repo, stdout: 'ignore', stderr: 'ignore' })
  write(repo, 'shared.txt', agreeing ? 'one\nRESOLVED\nthree\n' : 'one\nOTHERWISE\nthree\n')
  commit(repo, 'merge t into batch')
  write(repo, 'after.txt', 'after\n')
  commit(repo, 'feat: after')
  git(['checkout', '-q', 't'], repo)
  Bun.spawnSync(['git', 'merge', '-q', '--no-edit', 'batch'], { cwd: repo, stdout: 'ignore', stderr: 'ignore' })
  if (!agreeing) {
    write(repo, 'shared.txt', 'one\nRESOLVED\nthree\n')
    commit(repo, 'merge batch, resolved')
  }
  return { repo, reviewed }
}

test('a criss-cross whose inner resolutions agree is clean, and git merges it unaided', async () => {
  const { repo, reviewed } = crissCross(true)
  expect(revParse(repo, 'HEAD')).not.toBe(reviewed)
  expect(revParse(repo, 'HEAD^2')).toBe(revParse(repo, 'batch'))
  expect(await walk(repo, reviewed)).toEqual({ clean: true })
})

test('a criss-cross whose inner resolutions disagree is dirty', async () => {
  const { repo, reviewed } = crissCross(false)
  expect(await walk(repo, reviewed)).toMatchObject({ clean: false })
})

test('a merge driver the repo declares is honoured, as git merge honours it', async () => {
  const { repo, landSha: _ } = forked()
  git(['checkout', '-q', 'batch'], repo)
  write(repo, '.gitattributes', 'log.txt merge=union\n')
  write(repo, 'log.txt', 'a\n')
  commit(repo, 'chore: union log')
  git(['checkout', '-q', 't'], repo)
  merge(repo, 'batch')
  write(repo, 'log.txt', 'a\ntask\n')
  commit(repo, 'feat: task logs')
  const reviewed = revParse(repo, 'HEAD')
  onBatch(repo, 'log.txt', 'a\nbatch\n')
  merge(repo, 'batch')
  expect(await walk(repo, reviewed)).toEqual({ clean: true })
})

test('with no reviewed head recorded, nothing is clean', async () => {
  const { repo } = forked()
  merge(repo, 'batch')
  expect(await syncWalk(repo, null, 'batch')).toMatchObject({ clean: false })
})

test('a branch that adds nothing outside the pipeline\'s own docs has nothing to land', async () => {
  const { repo } = forked()
  expect(await nothingToLand(repo, 'batch')).toBe(false)
  git(['checkout', '-q', '-b', 'docs-only', 'batch'], repo)
  Bun.spawnSync(['mkdir', '-p', join(repo, 'docs/superpowers/specs')])
  write(repo, 'docs/superpowers/specs/s.md', 'spec\n')
  commit(repo, 'docs: spec only')
  merge(repo, 'batch')
  expect(await nothingToLand(repo, 'batch')).toBe(true)
  git(['checkout', '-q', 'batch'], repo)
  expect(await nothingToLand(repo, 'batch')).toBe(true)
})
