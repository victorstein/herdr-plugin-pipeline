import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupFixtures, git, tempDir } from './helpers/git-worktree'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const PLUGIN_ROOT = join(import.meta.dir, '..')

afterEach(cleanupFixtures)

interface Fixture { repo: string; stateDir: string; env: Record<string, string> }

/**
 * A real git repo and a scratch ledger. `cmdTask` needs `git rev-parse
 * --show-toplevel` to succeed and an agent file to exist, and the env has to be
 * pinned: a pane running the pipeline carries HERDR_SESSION and no
 * HERDR_PLUGIN_STATE_DIR, so an inherited environment would write these fixtures
 * into the live ledger the supervisor is driving.
 */
function fixture(): Fixture {
  const repo = tempDir('hpipe-argv-repo-')
  git(['init', '-q'], repo)
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'agents', 'core-dev.md'), '# core-dev\n')

  const stateDir = tempDir('hpipe-argv-state-')
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_ROOT: PLUGIN_ROOT,
    HERDR_SESSION: 'argv-fixture',
    HERDR_SOCKET_PATH: '',
  }
  return { repo, stateDir, env }
}

function hpipe(args: string[], f: Fixture): { code: number; out: string } {
  const proc = Bun.spawnSync(['bun', 'run', CLI, ...args], {
    cwd: f.repo, env: f.env, stdout: 'pipe', stderr: 'pipe',
  })
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() }
}

function started(): Fixture {
  const f = fixture()
  expect(hpipe(['start', 'argv fixture'], f).code).toBe(0)
  return f
}

const TASK = ['task', '--branch', 'smoke/one', '--issue', '1', '--surface', 'core']

test('a comma-separated --files reaches the ledger as separate entries', () => {
  const f = started()
  const r = hpipe([...TASK, '--files', 'src/a.ts,src/b.ts'], f)

  expect(r.code).toBe(0)
  expect(r.out).toContain('files: src/a.ts, src/b.ts')
  // Proof the pinned state dir, not the live one, received the run.
  expect(existsSync(join(f.stateDir, 'runs', 'argv-fixture'))).toBe(true)
})

test('a repeated --files accumulates through the real parser', () => {
  const f = started()
  const r = hpipe([...TASK, '--files', 'src/a.ts', '--files', 'src/b.ts'], f)

  expect(r.code).toBe(0)
  expect(r.out).toContain('files: src/a.ts, src/b.ts')
})

test('a space-separated --files is rejected and registers nothing', () => {
  const f = started()
  const r = hpipe([...TASK, '--files', 'src/a.ts src/b.ts'], f)

  expect(r.code).toBe(1)
  expect(r.out).toContain('--files is comma-separated')
  expect(r.out).toContain('--files src/a.ts,src/b.ts')
  expect(r.out).not.toContain('task_id:')
})

test('a valueless --files swallows the next flag and is rejected, though --surface was well-formed', () => {
  const f = started()
  const r = hpipe(['task', '--branch', 'smoke/one', '--issue', '1', '--files', '--surface', 'core'], f)

  expect(r.code).toBe(1)
  expect(r.out).toContain('--files got a flag where a path prefix belongs: "--surface"')
  // The measured silence this rule breaks: `flag` re-scans argv per name, so
  // --surface still resolved to core and nothing else about the command looked
  // wrong. Only --files was poisoned.
  expect(r.out).not.toContain('no agent definition')
})

test('no --files at all echoes files: none', () => {
  const f = started()
  const r = hpipe([...TASK], f)

  expect(r.code).toBe(0)
  expect(r.out).toContain('files: none')
})
