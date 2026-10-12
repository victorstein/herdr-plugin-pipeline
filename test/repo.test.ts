import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { actionRepoContext, focusedCwd } from '../src/lib/repo'
import { cleanupFixtures, tempDir } from './helpers/git-worktree'

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
