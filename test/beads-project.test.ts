import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beadsDir, beadsExportPath, beadsHome, beadsSlug, beadsSpawnEnv, defaultPrefix, normalisePrefix,
  prefixCollisions, prefixOwner, readBeadsProject, writeBeadsProject,
} from '../src/lib/beads-project'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'beads-project-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('the slug is the sanitised repo name and six hex chars of the repo key\'s hash', () => {
  const slug = beadsSlug('/Users/x/Code/Herdr Plugin')
  expect(slug).toMatch(/^herdr-plugin-[0-9a-f]{6}$/)
  expect(beadsSlug('/Users/x/Code/Herdr Plugin')).toBe(slug)
  expect(beadsSlug('/Users/y/Code/Herdr Plugin')).not.toBe(slug)
  expect(beadsSlug('/')).toMatch(/^repo-[0-9a-f]{6}$/)
})

test('the default prefix is the name cut to eight characters, with a trailing dash trimmed as bd does', () => {
  expect(defaultPrefix('/x/herdr-plugin-pipeline')).toBe('herdr-pl')
  expect(defaultPrefix('/x/abcdefg-xyz')).toBe('abcdefg')
  expect(defaultPrefix('/x/api')).toBe('api')
  expect(defaultPrefix('/')).toBe('repo')
})

test('a prefix is lowercased and trimmed, and anything but letters, digits and dashes is refused', () => {
  expect(normalisePrefix('HP-')).toBe('hp')
  expect(normalisePrefix(' web2 ')).toBe('web2')
  expect(normalisePrefix('bad prefix')).toBeNull()
  expect(normalisePrefix('-x')).toBeNull()
  expect(normalisePrefix('')).toBeNull()
})

test('a prefix must start with a letter, since an all-digit one would match every dated artifact', () => {
  expect(normalisePrefix('2026')).toBeNull()
  expect(normalisePrefix('9web')).toBeNull()
  expect(normalisePrefix('w2026')).toBe('w2026')
})

test('store paths live under $STATE/beads/<slug>, and every spawn gets BEADS_DIR and the git ceiling', () => {
  expect(beadsHome(dir, 'r-abc123')).toBe(join(dir, 'beads', 'r-abc123'))
  expect(beadsDir(dir, 'r-abc123')).toBe(join(dir, 'beads', 'r-abc123', '.beads'))
  expect(beadsExportPath(dir, 'r-abc123')).toBe(join(dir, 'beads', 'r-abc123', '.beads', 'issues.jsonl'))
  const env = beadsSpawnEnv(dir, 'r-abc123')
  expect(env.BEADS_DIR).toBe(join(dir, 'beads', 'r-abc123', '.beads'))
  expect(env.GIT_CEILING_DIRECTORIES).toBe(join(dir, 'beads'))
  expect(env.PATH).toBe(process.env.PATH)
})

test('project.json round-trips, and a prefix is found in another project but never in its own', async () => {
  expect(await readBeadsProject(dir, 'a-111111')).toBeNull()
  await writeBeadsProject(dir, 'a-111111', { repo_root: '/r/a', prefix: 'hp', created_at: 5 })
  expect(await readBeadsProject(dir, 'a-111111')).toEqual({ repo_root: '/r/a', prefix: 'hp', created_at: 5 })

  expect(await prefixOwner(dir, 'hp', 'b-222222')).toEqual({ repo_root: '/r/a', prefix: 'hp', created_at: 5 })
  expect(await prefixOwner(dir, 'hp', 'a-111111')).toBeNull()
  expect(await prefixOwner(dir, 'web', 'b-222222')).toBeNull()
})

test('prefixOwner with no beads directory at all finds nothing', async () => {
  expect(await prefixOwner(join(dir, 'missing'), 'hp', 'a-111111')).toBeNull()
})

test('the durability scan finds <prefix>-<n> names under docs/superpowers and nothing else', () => {
  const repo = join(dir, 'repo')
  for (const sub of ['specs', 'reviews', 'plans']) mkdirSync(join(repo, 'docs', 'superpowers', sub), { recursive: true })
  writeFileSync(join(repo, 'docs/superpowers/specs/2026-10-02-hp-3-design.md'), '')
  writeFileSync(join(repo, 'docs/superpowers/reviews/hp-12-spec-review-0.md'), '')
  writeFileSync(join(repo, 'docs/superpowers/plans/2026-09-17-issue-3-plan.md'), '')
  writeFileSync(join(repo, 'docs/superpowers/plans/chp-3-plan.md'), '')

  expect(prefixCollisions(repo, 'hp')).toEqual([
    'docs/superpowers/reviews/hp-12-spec-review-0.md',
    'docs/superpowers/specs/2026-10-02-hp-3-design.md',
  ])
  expect(prefixCollisions(repo, 'web')).toEqual([])
  expect(prefixCollisions(join(dir, 'no-docs'), 'hp')).toEqual([])
})

test('the durability scan ignores case in artifact names', () => {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'docs', 'superpowers', 'specs'), { recursive: true })
  writeFileSync(join(repo, 'docs/superpowers/specs/2026-10-02-HP-3-design.md'), '')
  expect(prefixCollisions(repo, 'hp')).toEqual(['docs/superpowers/specs/2026-10-02-HP-3-design.md'])
})

test('a docs/superpowers that cannot be read as a directory is treated as holding no collisions', () => {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'superpowers'), 'hp-1')
  expect(prefixCollisions(repo, 'hp')).toEqual([])
})

test('an unreadable directory under docs/superpowers is skipped while its siblings are still scanned', () => {
  if (process.getuid?.() === 0) return
  const repo = join(dir, 'repo')
  const root = join(repo, 'docs', 'superpowers')
  mkdirSync(join(root, 'locked'), { recursive: true })
  mkdirSync(join(root, 'specs'), { recursive: true })
  writeFileSync(join(root, 'locked', 'hp-2-design.md'), '')
  writeFileSync(join(root, 'specs', 'hp-1-design.md'), '')
  chmodSync(join(root, 'locked'), 0o000)
  try {
    expect(prefixCollisions(repo, 'hp')).toEqual(['docs/superpowers/specs/hp-1-design.md'])
  } finally {
    chmodSync(join(root, 'locked'), 0o755)
  }
})

test('an unreadable docs/superpowers is treated as holding no collisions', () => {
  if (process.getuid?.() === 0) return
  const repo = join(dir, 'repo')
  const root = join(repo, 'docs', 'superpowers')
  mkdirSync(join(root, 'specs'), { recursive: true })
  writeFileSync(join(root, 'specs', 'hp-1-design.md'), '')
  chmodSync(root, 0o000)
  try {
    expect(prefixCollisions(repo, 'hp')).toEqual([])
  } finally {
    chmodSync(root, 0o755)
  }
})
