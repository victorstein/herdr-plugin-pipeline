import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoBootstrap } from '../src/lib/bootstrap'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A repo root carrying `.claude/pipeline-bootstrap` at the given mode, or nothing. */
function repoRoot(mode: number | null): string {
  const root = mkdtempSync(join(tmpdir(), 'boot-repo-'))
  dirs.push(root)
  if (mode === null) return root
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'pipeline-bootstrap'), '#!/bin/sh\ntrue\n')
  chmodSync(join(root, '.claude', 'pipeline-bootstrap'), mode)
  return root
}

test('a repo with no .claude declares nothing', () => {
  expect(repoBootstrap(repoRoot(null))).toEqual({ kind: 'none' })
})

test('an executable pipeline-bootstrap is ready', () => {
  expect(repoBootstrap(repoRoot(0o755))).toEqual({ kind: 'ready' })
})

test('a non-executable pipeline-bootstrap is reported, not ignored', () => {
  expect(repoBootstrap(repoRoot(0o644))).toEqual({ kind: 'not-executable' })
})

test('a directory at that path declares nothing', () => {
  // A directory has the executable bits set, so a mode test alone would call it
  // `ready` and the orchestrator would try to run it.
  const root = mkdtempSync(join(tmpdir(), 'boot-repo-'))
  dirs.push(root)
  mkdirSync(join(root, '.claude', 'pipeline-bootstrap'), { recursive: true })
  expect(repoBootstrap(root)).toEqual({ kind: 'none' })
})

test('a nonexistent repo root declares nothing and does not throw', () => {
  expect(repoBootstrap('/nonexistent-repo-root-for-issue-16')).toEqual({ kind: 'none' })
})
