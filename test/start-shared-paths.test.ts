import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetDispatchBases } from '../src/lib/dispatch-base'
import { listRuns } from '../src/lib/ledger'
import { SUPERVISOR_CAPABILITIES } from '../src/lib/pidfile'
import { SHARED_PATHS_REL } from '../src/lib/shared-paths'
import type { SupervisorPid } from '../src/lib/types'
import { cmdStart, startBatch, startBeads } from './helpers/cmd-start'
import { cleanupFixtures, cloneOfRemote, commitAs, git, revParse, tempDir } from './helpers/git-worktree'

/**
 * `start` reads the list once, from the commit the run is cut from, through real
 * git: a clone whose own working tree and local `main` never saw the file.
 */

let dir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'start-shared-paths-')) })
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  forgetDispatchBases()
  cleanupFixtures()
})

const input = (repoRoot: string, singlePr = false) => ({
  title: 'registry', repoKey: repoRoot, repoRoot, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
  singlePr, batchBranch: singlePr ? 'batch/registry' : null,
})

/** Another clone lands the list on origin's main, as a merged PR would. Returns the commit. */
function landList(remote: string, text: string): string {
  const other = join(tempDir('hpipe-lister-'), 'other')
  git(['clone', '-q', remote, other], tempDir('hpipe-cwd-'))
  commitAs(other, SHARED_PATHS_REL, text)
  git(['push', '-q', 'origin', 'HEAD:main'], other)
  return revParse(other, 'HEAD')
}

const savedRun = async () => (await listRuns(dir, 'personal'))[0]!

const supervisorPid = (capabilities?: string[]): SupervisorPid => ({
  pid: 77, pane_pid: 1, started_at_ms: 1, session: 'personal', socket_path: '/s', pane_id: 'w1:p9',
  schemas: [3, 4], ...(capabilities === undefined ? {} : { capabilities }),
})

test('a per-task start reads the list at origin\'s default branch as just fetched, and stores the snapshot', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const listed = landList(remote, '# appended by every task\ndocs/file-formats.md\nCHANGELOG.md\n')

  const out = await cmdStart(ctx(), input(clone))
  expect(out.ok).toBe(true)
  expect(out.text).toContain(`shared: docs/file-formats.md, CHANGELOG.md — from ${SHARED_PATHS_REL} at ` +
    `${listed.slice(0, 8)} (origin/main as just fetched); never locked`)
  expect(out.text).not.toContain('⚠ shared')
  expect(out.text.indexOf('shared: ')).toBeLessThan(out.text.indexOf('# Intake'))

  const run = await savedRun()
  expect(run.shared_paths).toMatchObject({
    prefixes: ['docs/file-formats.md', 'CHANGELOG.md'], ignored: [], commit: listed, ref: 'origin/main',
  })
  expect(run.shared_paths?.error).toBeUndefined()
})

test('a single-PR start reads the list at the batch\'s base, the commit it just fetched', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const listed = landList(remote, 'docs/registry.md\n')

  const out = await cmdStart(ctx(), input(clone, true))
  expect(out.ok).toBe(true)
  expect(out.text).toContain(`batch: batch/registry at ${listed.slice(0, 8)}`)
  expect(out.text).toContain(`shared: docs/registry.md — from ${SHARED_PATHS_REL} at ${listed.slice(0, 8)} ` +
    '(origin/main as just fetched); never locked')
  expect((await savedRun()).shared_paths).toMatchObject({ prefixes: ['docs/registry.md'], commit: listed })
})

test('a list the local checkout has but origin\'s main does not shares nothing', async () => {
  const { clone } = cloneOfRemote('main')
  commitAs(clone, SHARED_PATHS_REL, 'docs/registry.md\n')

  const out = await cmdStart(ctx(), input(clone))
  expect(out.ok).toBe(true)
  expect(out.text).not.toContain('shared:')
  expect((await savedRun()).shared_paths).toMatchObject({ prefixes: [], ignored: [], ref: 'origin/main' })
})

test('with no list, start says nothing about it', async () => {
  const { clone } = cloneOfRemote('main')
  const out = await cmdStart(ctx(), input(clone))
  expect(out.ok).toBe(true)
  expect(out.text).not.toContain('shared:')
  expect((await savedRun()).shared_paths?.prefixes).toEqual([])
})

test('each ignored line is warned about, and the rest are still shared', async () => {
  const { remote, clone } = cloneOfRemote('main')
  landList(remote, 'docs/*.md\n/\ndocs/registry.md\n')

  const out = await cmdStart(ctx(), input(clone))
  expect(out.ok).toBe(true)
  expect(out.text).toContain('shared: docs/registry.md — ')
  expect(out.text).toContain(`⚠ shared: ignored "docs/*.md" in ${SHARED_PATHS_REL} — a glob would share more ` +
    'than it names: list each path')
  expect(out.text).toContain(`⚠ shared: ignored "/" in ${SHARED_PATHS_REL} — it would share the whole repo`)
  expect((await savedRun()).shared_paths?.ignored).toEqual(['docs/*.md', '/'])
})

test('a failed fetch reads the last fetched commit, and says it may be stale', async () => {
  const { remote, clone } = cloneOfRemote('main')
  landList(remote, 'docs/registry.md\n')
  git(['fetch', '-q', 'origin'], clone)
  const stale = revParse(clone, 'refs/remotes/origin/main')
  git(['remote', 'set-url', 'origin', join(tempDir('hpipe-gone-'), 'missing')], clone)

  const out = await cmdStart(ctx(), input(clone))
  expect(out.ok).toBe(true)
  expect(out.text).toMatch(new RegExp(`shared: docs/registry.md — from ${SHARED_PATHS_REL} at ${stale.slice(0, 8)} ` +
    '\\(fetch failed: .*; local origin/main, may be stale\\); never locked'))
  expect((await savedRun()).shared_paths).toMatchObject({ prefixes: ['docs/registry.md'], commit: stale })
})

test('an unreadable ref shares nothing and warns, and start still goes ahead', async () => {
  const notARepo = tempDir('hpipe-not-a-repo-')
  writeFileSync(join(notARepo, 'README.md'), 'not under git\n')

  const out = await cmdStart(ctx(), input(notARepo))
  expect(out.ok).toBe(true)
  expect(out.text).toContain(`⚠ shared: git could not read ${SHARED_PATHS_REL} at main: nothing is shared, ` +
    'so every declared path locks')
  const run = await savedRun()
  expect(run.shared_paths).toMatchObject({ prefixes: [], commit: null, ref: 'main' })
  expect(run.shared_paths?.error).toBe(`git could not read ${SHARED_PATHS_REL} at main`)
  expect(readFileSync(join(notARepo, 'README.md'), 'utf8')).toBe('not under git\n')
})

test('beside a supervisor that predates shared paths, start warns that it locks them anyway', async () => {
  const { remote, clone } = cloneOfRemote('main')
  landList(remote, 'docs/registry.md\n')

  const old = await cmdStart(ctx(), input(clone), startBeads(),
    startBatch({ supervisor: async () => ({ state: 'live', info: supervisorPid() }) }))
  expect(old.ok).toBe(true)
  expect(old.text).toContain('⚠ shared: the supervisor of session personal (pid 77) predates shared paths and ' +
    'locks them anyway')
  expect(old.text).toContain('Pipeline supervisor')
})

test('beside a current supervisor, a stale one or none, start does not warn about the supervisor', async () => {
  for (const state of [
    { state: 'live' as const, info: supervisorPid([...SUPERVISOR_CAPABILITIES]) },
    { state: 'stale' as const, info: supervisorPid() },
    { state: 'none' as const },
  ]) {
    rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 'start-shared-paths-'))
    const { remote, clone } = cloneOfRemote('main')
    landList(remote, 'docs/registry.md\n')
    const out = await cmdStart(ctx(), input(clone), startBeads(), startBatch({ supervisor: async () => state }))
    expect(out.ok, state.state).toBe(true)
    expect(out.text, state.state).toContain('shared: docs/registry.md')
    expect(out.text, state.state).not.toContain('predates shared paths')
  }
})

test('with nothing shared, an old supervisor draws no warning', async () => {
  const { clone } = cloneOfRemote('main')
  const out = await cmdStart(ctx(), input(clone), startBeads(),
    startBatch({ supervisor: async () => ({ state: 'live', info: supervisorPid() }) }))
  expect(out.ok).toBe(true)
  expect(out.text).not.toContain('predates shared paths')
})
