import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_DEADLINE_MS, CHECK_REL, checkFailure, checkLine, repoCheck, runCheck } from '../src/lib/check'

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

test('a check gets less than the 10-minute Bash timeout submit runs under, so it is stopped before submit is', () => {
  expect(CHECK_DEADLINE_MS).toBeLessThan(10 * 60_000)
  expect(checkFailure({ code: 3, tail: '' })).toBe('failed (exit 3)')
  expect(checkFailure({ code: -1, tail: '', timedOutAfterMs: CHECK_DEADLINE_MS }))
    .toBe('did not finish within 9m and was stopped, with everything it started')
})

test('a check that hangs is stopped at its deadline with everything it started, and says so in its log', async () => {
  const root = repoRoot(null)
  const childPid = join(root, 'child.pid')
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, CHECK_REL), `#!/bin/sh\necho started\nsleep 30 &\necho $! > '${childPid}'\nwait\n`)
  chmodSync(join(root, CHECK_REL), 0o755)
  const log = join(root, 'check.log')

  const started = Date.now()
  const ran = await runCheck(root, log, 500)
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(ran.timedOutAfterMs).toBe(500)
  expect(ran.code).not.toBe(0)
  expect(ran.tail).toContain('started')
  expect(readFileSync(log, 'utf8')).toContain(`${CHECK_REL} was stopped after 0.5s`)

  expect(existsSync(childPid)).toBe(true)
  const pid = Number(readFileSync(childPid, 'utf8').trim())
  await Bun.sleep(100)
  expect(() => process.kill(pid, 0)).toThrow()
})

test('a check that finishes in time reports its own exit code', async () => {
  const root = repoRoot(null)
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, CHECK_REL), '#!/bin/sh\necho red\nexit 3\n')
  chmodSync(join(root, CHECK_REL), 0o755)
  const ran = await runCheck(root, join(root, 'check.log'))
  expect(ran).toEqual({ code: 3, tail: 'red' })
})
