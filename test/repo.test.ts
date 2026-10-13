import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { actionRepoContext, excludeFromGit, focusedCwd } from '../src/lib/repo'
import { cleanupFixtures, repoWithWorktree, tempDir } from './helpers/git-worktree'

afterEach(cleanupFixtures)

const context = (value: unknown) => ({ HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(value) })

test('an action reads the focused pane\'s directory from herdr\'s context, not its own cwd — #3', () => {
  expect(focusedCwd(context({ focused_pane_cwd: '/repo/sub' }))).toBe('/repo/sub')
  expect(focusedCwd(context({ focused_pane_cwd: '/repo/sub', worktree: { repo_root: '/repo' } }))).toBe('/repo')
})

test('no context, a malformed one or one with no directory is no directory at all', () => {
  expect(focusedCwd({})).toBeNull()
  expect(focusedCwd({ HERDR_PLUGIN_CONTEXT_JSON: '{not json' })).toBeNull()
  expect(focusedCwd(context({ focused_pane_id: 'w1:p1' }))).toBeNull()
})

test('the repo resolves from the focused pane, even when the action runs inside another repo', async () => {
  const repo = tempDir('hpipe-repo-')
  await Bun.$`git init -q ${repo}`
  mkdirSync(join(repo, 'src'))
  const resolved = await actionRepoContext(context({ focused_pane_cwd: join(repo, 'src') }))
  const real = (await Bun.$`git -C ${repo} rev-parse --show-toplevel`.text()).trim()
  expect(resolved).toEqual({ repoKey: real, repoRoot: real })
})

test('with no focused pane the action has no repo, rather than falling back to its own checkout', async () => {
  expect(await actionRepoContext({})).toBeNull()
})

// The branch review must never be committed, and untracked in the user's working copy it was one
// `git add -A` from shipping. Measured on a live run.
test('a path excluded through the shared info/exclude leaves git status and git add -A alone, once', async () => {
  const worktree = repoWithWorktree(['README.md'])
  const repo = (await Bun.$`git -C ${worktree} rev-parse --path-format=absolute --git-common-dir`.text()).trim()
  const review = 'docs/superpowers/reviews/r1-branch-review-0.md'
  mkdirSync(join(worktree, 'docs', 'superpowers', 'reviews'), { recursive: true })
  writeFileSync(join(worktree, review), 'VERDICT: CLEAR\n')

  expect(await excludeFromGit(worktree, review)).toBeNull()
  expect(await excludeFromGit(worktree, review)).toBeNull()
  expect(readFileSync(join(repo, 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === `/${review}`))
    .toHaveLength(1)
  expect((await Bun.$`git -C ${worktree} status --porcelain`.text()).trim()).toBe('')
  await Bun.$`git -C ${worktree} add -A`
  expect((await Bun.$`git -C ${worktree} diff --cached --name-only`.text()).trim()).toBe('')
})

test('excluding outside a repo says why, and writes nothing', async () => {
  expect(await excludeFromGit(tempDir('hpipe-nogit-'), 'x.md')).toContain('not a git repository')
})
