import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkReleaseTitle, DEFAULT_RELEASE_SECTIONS, parseTitle, releaseSections } from '../src/lib/release-title'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function repoWith(config: object | null): string {
  const root = mkdtempSync(join(tmpdir(), 'release-'))
  dirs.push(root)
  if (config !== null) writeFileSync(join(root, 'release-please-config.json'), JSON.stringify(config))
  return root
}

test('a title is one conventional line, with an optional scope and breaking mark', () => {
  expect(parseTitle('fix(reader): close the menu')).toEqual({ type: 'fix', breaking: false })
  expect(parseTitle('feat!: drop v1')).toEqual({ type: 'feat', breaking: true })
  expect(parseTitle("fix: don't re-render")).toEqual({ type: 'fix', breaking: false })
  for (const bad of ['fix:no space', 'Fix: capital', 'fix(a b): space in scope', 'fix: one\nfeat: two', 'close the menu']) {
    expect(parseTitle(bad), bad).toBeNull()
  }
})

test('the type must be one the repo\'s release notes read: feet: passes the pattern and is refused', () => {
  const sections = releaseSections(repoWith({ 'changelog-sections': [{ type: 'feat' }, { type: 'fix' }] }))
  expect(checkReleaseTitle('feet: add bookmarks', sections)).toMatchObject({ ok: false })
  expect((checkReleaseTitle('feet: add bookmarks', sections) as { error: string }).error).toContain('feat, fix')
  expect(checkReleaseTitle('feat: add bookmarks', sections)).toEqual({ ok: true, note: null })
  expect(checkReleaseTitle('add bookmarks', sections)).toMatchObject({ ok: false })
})

test('a known type the config hides passes, with a note that it will not appear', () => {
  const sections = releaseSections(repoWith({ 'changelog-sections': [{ type: 'chore', hidden: true }] }))
  const result = checkReleaseTitle('chore: bump deps', sections)
  expect(result.ok).toBe(true)
  expect((result as { note: string }).note).toContain('hidden')
})

test('the root package\'s sections win over the top level, and no config means release-please\'s default list', () => {
  const both = repoWith({
    'changelog-sections': [{ type: 'feat' }],
    packages: { '.': { 'changelog-sections': [{ type: 'fix' }] } },
  })
  expect(releaseSections(both).map((s) => s.type)).toEqual(['fix'])
  expect(releaseSections(repoWith(null))).toBe(DEFAULT_RELEASE_SECTIONS)
  expect(releaseSections(repoWith({ packages: { '.': {} } }))).toBe(DEFAULT_RELEASE_SECTIONS)
  expect(checkReleaseTitle('perf: faster', DEFAULT_RELEASE_SECTIONS)).toEqual({ ok: true, note: null })
})

test('the default list is conventional-changelog-conventionalcommits\', which release-please uses unconfigured', () => {
  const shown = DEFAULT_RELEASE_SECTIONS.filter((s) => s.hidden !== true).map((s) => s.type)
  const hidden = DEFAULT_RELEASE_SECTIONS.filter((s) => s.hidden === true).map((s) => s.type)
  expect(shown).toEqual(['feat', 'feature', 'fix', 'perf', 'revert'])
  expect(hidden).toEqual(['docs', 'style', 'chore', 'refactor', 'test', 'build', 'ci'])
  expect(checkReleaseTitle('feature: bookmarks', DEFAULT_RELEASE_SECTIONS)).toEqual({ ok: true, note: null })
  expect(checkReleaseTitle('deps: bump bun', DEFAULT_RELEASE_SECTIONS).ok).toBe(false)
})

test('this repo\'s own config is read: chore is hidden, refactor is shown', () => {
  const sections = releaseSections(join(import.meta.dir, '..'))
  expect(checkReleaseTitle('refactor: x', sections)).toEqual({ ok: true, note: null })
  expect(checkReleaseTitle('chore: x', sections).ok).toBe(true)
  expect(checkReleaseTitle('revert: x', sections).ok).toBe(false)
})
