import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import {
  atLeast, bdProblem, BD_MIN_VERSION, BV_MIN_VERSION, bvProblem, checkTool, parseVersion, toolsLine,
} from '../src/lib/tools'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tools-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('the version is the first x.y.z in the output, whatever surrounds it', () => {
  expect(parseVersion('bd version 1.3.1 (Homebrew)\n')).toBe('1.3.1')
  expect(parseVersion('bv v0.25.2\n')).toBe('0.25.2')
  expect(parseVersion('no version here')).toBeNull()
})

test('versions compare numerically, part by part', () => {
  expect(atLeast('1.3.1', '1.3.1')).toBe(true)
  expect(atLeast('1.10.0', '1.3.1')).toBe(true)
  expect(atLeast('1.0.4', '1.3.1')).toBe(false)
  expect(atLeast('0.25.1', '0.25.2')).toBe(false)
})

test('checkTool reads a good, an old and a missing binary', async () => {
  const good = await makeFakeBin(join(dir), { version: 'bd version 1.3.1 (Homebrew)\n' })
  expect(await checkTool([good, 'version'], BD_MIN_VERSION)).toEqual({ state: 'ok', version: '1.3.1' })

  const oldDir = mkdtempSync(join(dir, 'old-'))
  const old = await makeFakeBin(oldDir, { version: 'bd version 1.0.4 (Homebrew)\n' })
  expect(await checkTool([old, 'version'], BD_MIN_VERSION)).toEqual({ state: 'old', version: '1.0.4' })

  const missing = await checkTool([join(dir, 'no-such-bv'), '--version'], BV_MIN_VERSION)
  expect(missing.state).toBe('missing')
})

test('the problems name the fix, and the tools line is absent when both are fine', () => {
  const ok = { state: 'ok', version: '9.9.9' } as const
  expect(bdProblem(ok)).toBeNull()
  expect(bdProblem({ state: 'old', version: '1.0.4' })).toContain('brew upgrade beads')
  expect(bdProblem({ state: 'missing', detail: 'ENOENT' })).toContain('brew install beads')
  expect(bvProblem({ state: 'missing', detail: 'ENOENT' })).toContain('brew install dicklesworthstone/tap/bv')
  expect(toolsLine({ bd: ok, bv: ok })).toBeNull()
  expect(toolsLine({ bd: ok, bv: { state: 'old', version: '0.20.0' } }))
    .toBe(`tools: bv 0.20.0 is older than ${BV_MIN_VERSION} — brew upgrade bv`)
})
