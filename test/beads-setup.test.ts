import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadsHome, beadsSlug, readBeadsProject, writeBeadsProject } from '../src/lib/beads-project'
import { setupBeads, setupLines, type SetupDeps } from '../src/lib/beads-setup'

let dir: string
let repo: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'beads-setup-state-'))
  repo = mkdtempSync(join(tmpdir(), 'beads-setup-repo-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const KEY = '/code/herdr-plugin-pipeline'

function fakeDeps(over: Partial<SetupDeps> = {}): { deps: SetupDeps; inits: Array<[string, string]> } {
  const inits: Array<[string, string]> = []
  return {
    inits,
    deps: {
      initStore: async (_stateDir, slug, prefix) => { inits.push([slug, prefix]); return { ok: true } },
      enclosingWorkTree: async () => false,
      now: () => 42,
      ...over,
    },
  }
}

test('a first setup inits the store under the default prefix and records project.json', async () => {
  const { deps, inits } = fakeDeps()
  const slug = beadsSlug(KEY)
  expect(await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: null }, deps))
    .toEqual({ ok: true, slug, prefix: 'herdr-pl', created: true, notes: [] })
  expect(inits).toEqual([[slug, 'herdr-pl']])
  expect(await readBeadsProject(dir, slug)).toEqual({ repo_root: repo, prefix: 'herdr-pl', created_at: 42 })
})

test('--prefix overrides the default, normalised the way bd stores it', async () => {
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'HP-' }, deps)
  expect(result.ok && result.prefix).toBe('hp')
  expect(inits.map(([, prefix]) => prefix)).toEqual(['hp'])
})

test('an existing store is left alone, and a --prefix that disagrees with it is reported as ignored', async () => {
  const slug = beadsSlug(KEY)
  await writeBeadsProject(dir, slug, { repo_root: repo, prefix: 'hp', created_at: 1 })
  const { deps, inits } = fakeDeps()
  expect(await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'web' }, deps)).toEqual({
    ok: true, slug, prefix: 'hp', created: false,
    notes: ['this repo\'s Beads store already uses prefix hp; --prefix web was ignored'],
  })
  expect(inits).toEqual([])
})

test('a malformed prefix is refused before anything is created', async () => {
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'two words' }, deps)
  expect(result).toEqual({
    ok: false, error: '--prefix must start with a letter and hold only lowercase letters, digits and dashes, got: two words',
  })
  expect(inits).toEqual([])
})

test('an all-digit prefix is refused, naming --prefix', async () => {
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: '2026' }, deps)
  expect(!result.ok && result.error).toContain('--prefix must start with a letter')
  expect(inits).toEqual([])
})

test('a repo whose name gives no usable default prefix is refused, asking for --prefix', async () => {
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: '/code/2026-notes', repoRoot: repo, prefix: null }, deps)
  expect(result).toEqual({
    ok: false,
    error: 'this repo\'s name gives the Beads prefix 2026-not, which does not start with a letter — pass --prefix <another>',
  })
  expect(inits).toEqual([])
})

test('a prefix another repo\'s store uses is refused, naming --prefix', async () => {
  await writeBeadsProject(dir, 'other-123456', { repo_root: '/code/other', prefix: 'hp', created_at: 1 })
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'hp' }, deps)
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toBe('prefix hp is already the Beads prefix of /code/other — pass --prefix <another>')
  expect(inits).toEqual([])
})

test('a prefix whose <prefix>-<n> names already sit under docs/superpowers is refused', async () => {
  mkdirSync(join(repo, 'docs', 'superpowers', 'specs'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'superpowers', 'specs', '2026-10-02-hp-1-design.md'), '')
  const { deps, inits } = fakeDeps()
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'hp' }, deps)
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toContain('docs/superpowers/specs/2026-10-02-hp-1-design.md')
  expect(!result.ok && result.error).toContain('pass --prefix <another>')
  expect(inits).toEqual([])
})

test('a state dir inside a git work tree is set up anyway, with a note saying why that is harmless', async () => {
  const { deps } = fakeDeps({ enclosingWorkTree: async () => true })
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'hp' }, deps)
  expect(result.ok && result.notes).toEqual([
    `${beadsHome(dir, beadsSlug(KEY))} sits inside a git work tree; every bd and bv call runs with ` +
      'GIT_CEILING_DIRECTORIES set, so none commits into it',
  ])
})

test('a failed bd init records nothing and passes bd\'s error through', async () => {
  const { deps } = fakeDeps({ initStore: async () => ({ reason: 'exit', error: 'Error: database is locked' }) })
  const result = await setupBeads({ stateDir: dir, repoKey: KEY, repoRoot: repo, prefix: 'hp' }, deps)
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toContain('Error: database is locked')
  expect(existsSync(join(beadsHome(dir, beadsSlug(KEY)), 'project.json'))).toBe(false)
})

test('setupLines says whether the store was created, then each note', () => {
  expect(setupLines({ ok: true, slug: 's-123456', prefix: 'hp', created: true, notes: ['n'] }, '/st')).toEqual([
    'beads: created /st/beads/s-123456 with prefix hp', 'beads: n',
  ])
  expect(setupLines({ ok: true, slug: 's-123456', prefix: 'hp', created: false, notes: [] }, '/st')).toEqual([
    'beads: prefix hp, store /st/beads/s-123456',
  ])
})
