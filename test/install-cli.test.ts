import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { binDir, installCli, onPath } from '../src/lib/install-cli'

let root: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plugin-'))
  home = mkdtempSync(join(tmpdir(), 'home-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'hpipe'), '#!/bin/sh\n')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const env = (over: Record<string, string> = {}) => ({ HOME: home, PATH: join(home, '.local/bin'), ...over })

test('it links the wrapper, never src/cli.ts directly', () => {
  // Linking the CLI pins hand-typed commands to one checkout while the
  // installed supervisor drives the same ledger.
  const result = installCli(root, env())
  expect(result.ok).toBe(true)
  expect(realpathSync(result.target)).toBe(realpathSync(join(root, 'bin', 'hpipe')))
})

test('it creates the bin directory when missing', () => {
  const result = installCli(root, env())
  expect(result.ok).toBe(true)
  expect(existsSync(join(home, '.local', 'bin', 'hpipe'))).toBe(true)
})

test('re-running is a no-op rather than an error', () => {
  installCli(root, env())
  const again = installCli(root, env())
  expect(again.ok).toBe(true)
  expect(again.lines.join(' ')).toContain('already linked')
})

test('it replaces a stale symlink pointing at another checkout', () => {
  const old = mkdtempSync(join(tmpdir(), 'old-'))
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(old, 'cli.ts'), '')
  symlinkSync(join(old, 'cli.ts'), join(home, '.local', 'bin', 'hpipe'))

  const result = installCli(root, env())
  expect(result.ok).toBe(true)
  expect(realpathSync(result.target)).toBe(realpathSync(join(root, 'bin', 'hpipe')))
  rmSync(old, { recursive: true, force: true })
})

test('it warns when the target directory is not on PATH', () => {
  const result = installCli(root, env({ PATH: '/usr/bin' }))
  expect(result.ok).toBe(true)
  expect(result.lines.join(' ')).toContain('not on your PATH')
})

test('HPIPE_BIN_DIR overrides the default location', () => {
  const custom = join(home, 'custom')
  const result = installCli(root, env({ HPIPE_BIN_DIR: custom }))
  expect(result.target).toBe(join(custom, 'hpipe'))
  expect(binDir({ HPIPE_BIN_DIR: custom })).toBe(custom)
})

test('it fails clearly when the wrapper is missing', () => {
  rmSync(join(root, 'bin', 'hpipe'))
  const result = installCli(root, env())
  expect(result.ok).toBe(false)
  expect(result.lines.join(' ')).toContain('no wrapper')
})

test('onPath compares whole entries, not substrings', () => {
  expect(onPath('/usr/bin', { PATH: '/usr/bin:/bin' })).toBe(true)
  expect(onPath('/usr/bin', { PATH: '/usr/binary:/bin' })).toBe(false)
})
