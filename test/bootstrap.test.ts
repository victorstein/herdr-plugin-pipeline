import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOOTSTRAP_REL, bootstrapLine, briefNote, repoBootstrap } from '../src/lib/bootstrap'

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

test('an undeclared repo still gets a line, the way files: does', () => {
  // src/cli.ts:254-257 records why: a declaration that matches nothing is
  // otherwise silent by construction.
  expect(bootstrapLine({ kind: 'none' })).toBe('bootstrap: none')
})

test('a ready declaration names the path', () => {
  expect(bootstrapLine({ kind: 'ready' })).toBe(`bootstrap: ${BOOTSTRAP_REL}`)
})

test('a non-executable declaration names the fix', () => {
  expect(bootstrapLine({ kind: 'not-executable' })).toContain('chmod +x')
})

test('every bootstrap line is exactly one line', () => {
  // Both emitters put this ABOVE the blank line that prompts/dispatch.md:26-30
  // uses to split orchestrator text from worker text. A newline here moves that
  // boundary and the orchestrator pastes its own instructions into the worker's
  // prompt.
  for (const kind of ['none', 'ready', 'not-executable'] as const) {
    expect(bootstrapLine({ kind })).not.toContain('\n')
  }
})

test('an undeclared repo adds nothing to the worker brief', () => {
  expect(briefNote({ kind: 'none' })).toBe('')
})

test('the worker note offers a recovery, it does not assert the bootstrap ran', () => {
  // The mechanism instructs, it does not enforce. A worker told flatly that its
  // checkout is bootstrapped will misdiagnose a real `command not found`.
  const note = briefNote({ kind: 'ready' })
  expect(note).toContain('should have been run')
  expect(note).not.toContain('run for you')
  expect(note).toContain(BOOTSTRAP_REL)
})

test('a non-executable declaration tells the worker how to fix it', () => {
  expect(briefNote({ kind: 'not-executable' })).toContain(`chmod +x ${BOOTSTRAP_REL}`)
})
test('a conventional bootstrap script that is not wired is pointed out, still on one line — #6', () => {
  // berean-os has ./bin/bootstrap and no pipeline-bootstrap, so every task printed
  // `bootstrap: none` and the orchestrator guessed it should run the script itself.
  const root = repoRoot(null)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'bootstrap'), '#!/bin/sh\ntrue\n')
  chmodSync(join(root, 'bin', 'bootstrap'), 0o755)
  const bootstrap = repoBootstrap(root)
  expect(bootstrap).toEqual({ kind: 'none', unwired: 'bin/bootstrap' })
  const line = bootstrapLine(bootstrap)
  expect(line).toBe('bootstrap: none (the repo has ./bin/bootstrap, which the dispatch does not run; ' +
    `an executable ${BOOTSTRAP_REL} that calls it would run it in every new worktree)`)
  expect(line).not.toContain('\n')
})

test('a declared bootstrap wins over a conventional script beside it', () => {
  const root = repoRoot(0o755)
  mkdirSync(join(root, 'script'))
  writeFileSync(join(root, 'script', 'bootstrap'), '#!/bin/sh\ntrue\n')
  chmodSync(join(root, 'script', 'bootstrap'), 0o755)
  expect(repoBootstrap(root)).toEqual({ kind: 'ready' })
})
