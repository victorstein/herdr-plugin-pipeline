import { expect, test } from 'bun:test'
import { SHARED_PATHS_REL, sharedPathPrefixes } from '../src/lib/shared-paths'

test('the file sits beside the other per-repo pipeline files', () => {
  expect(SHARED_PATHS_REL).toBe('.claude/pipeline-shared-paths')
})

test('one prefix per line, with comments and blank lines skipped', () => {
  const text = [
    '# appended to by every task',
    'docs/file-formats.md',
    '',
    '   ',
    'CHANGELOG.md   # release notes',
    '#docs/old.md',
  ].join('\n')
  expect(sharedPathPrefixes(text)).toEqual({ prefixes: ['docs/file-formats.md', 'CHANGELOG.md'], ignored: [] })
})

test('a leading ./ or / is stripped, as on the always-review list', () => {
  expect(sharedPathPrefixes('./docs/a.md\n/docs/b.md\n.//docs/c.md\n').prefixes)
    .toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
})

test('a glob is ignored, not cut to its prefix: docs/*.md would share all of docs/', () => {
  const text = 'docs/*.md\nsrc/gen?/x.ts\nsrc/[ab].ts\nsrc/{a,b}.ts\ndocs/registry.md\n'
  expect(sharedPathPrefixes(text)).toEqual({
    prefixes: ['docs/registry.md'],
    ignored: ['docs/*.md', 'src/gen?/x.ts', 'src/[ab].ts', 'src/{a,b}.ts'],
  })
})

test('a line that would share the whole repo is ignored', () => {
  expect(sharedPathPrefixes('/\n.\n./\n//\ndocs/a.md\n')).toEqual({
    prefixes: ['docs/a.md'], ignored: ['/', '.', './', '//'],
  })
})

test('prefixes stay plain prefixes, so a directory and a file both work', () => {
  expect(sharedPathPrefixes('docs/generated/\ndocs/file-formats\n').prefixes)
    .toEqual(['docs/generated/', 'docs/file-formats'])
})

test('CRLF line endings read the same', () => {
  expect(sharedPathPrefixes('docs/a.md\r\nCHANGELOG.md\r\n').prefixes).toEqual(['docs/a.md', 'CHANGELOG.md'])
})
