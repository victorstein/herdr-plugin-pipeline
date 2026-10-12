import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_REL, checkLine, repoCheck } from '../src/lib/check'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function repoRoot(mode: number | null): string {
  const root = mkdtempSync(join(tmpdir(), 'check-repo-'))
  dirs.push(root)
  if (mode === null) return root
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, CHECK_REL), '#!/bin/sh\ntrue\n')
  chmodSync(join(root, CHECK_REL), mode)
  return root
}

test('the check is declared beside the bootstrap', () => {
  expect(CHECK_REL).toBe('.claude/pipeline-check')
})

test('a repo declares no check, a ready one, or one that is not executable', () => {
  expect(repoCheck(repoRoot(null))).toEqual({ kind: 'none' })
  expect(repoCheck(repoRoot(0o755))).toEqual({ kind: 'ready' })
  expect(repoCheck(repoRoot(0o644))).toEqual({ kind: 'not-executable' })
})

test('a directory at the path, or a missing repo, declares nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-repo-'))
  dirs.push(root)
  mkdirSync(join(root, CHECK_REL), { recursive: true })
  expect(repoCheck(root)).toEqual({ kind: 'none' })
  expect(repoCheck('/nonexistent-repo-root-for-checks')).toEqual({ kind: 'none' })
})

test('start prints one check line, and with none says landings rest on the worker alone', () => {
  expect(checkLine({ kind: 'ready' })).toBe('check: .claude/pipeline-check')
  expect(checkLine({ kind: 'none' })).toBe(
    "check: none — each landing is checked only by its worker's own test run, and status says so",
  )
  expect(checkLine({ kind: 'not-executable' }))
    .toBe('check: .claude/pipeline-check (NOT EXECUTABLE — chmod +x it on the default branch, or every submit refuses)')
})
