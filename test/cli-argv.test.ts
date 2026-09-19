import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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

test('task run from a linked worktree registers into the parent repo run', () => {
  // A worker's cwd is a worktree, where --show-toplevel is the worktree itself
  // and never equals the run's repo_key. This is the assertion no unit test can
  // make: `dispatch` and `repoContext` are only reachable as a subprocess.
  const f = started()
  // Under tempDir, not beside f.repo: cleanupFixtures only removes what tempDir
  // registered, so a sibling path would be left in the system tmpdir by every run.
  const worktree = join(tempDir('hpipe-argv-wt-'), 'wt')
  git(['worktree', 'add', '-q', '-b', 'wt/one', worktree], f.repo)

  const proc = Bun.spawnSync(['bun', 'run', CLI, ...TASK], {
    cwd: worktree, env: f.env, stdout: 'pipe', stderr: 'pipe',
  })
  const out = proc.stdout.toString() + proc.stderr.toString()

  expect(out).toContain('task_id: t1')
  expect(proc.exitCode).toBe(0)
})

test('a resolving command outside a git repo names --run, and --run works from there', () => {
  const f = started()
  expect(hpipe([...TASK], f).code).toBe(0)
  const runId = readdirSync(join(f.stateDir, 'runs', 'argv-fixture'))[0]!.replace(/\.json$/, '')
  const outside = tempDir('hpipe-argv-nonrepo-')

  const bare = Bun.spawnSync(['bun', 'run', CLI, 'brief', '--task', 't1'], {
    cwd: outside, env: f.env, stdout: 'pipe', stderr: 'pipe',
  })
  const bareOut = bare.stdout.toString() + bare.stderr.toString()
  expect(bare.exitCode).toBe(1)
  expect(bareOut).toContain('not inside a git repository')
  expect(bareOut).toContain('--run')

  // Spec testing item 17: the escape the message names has to work from there.
  const named = Bun.spawnSync(['bun', 'run', CLI, 'brief', '--task', 't1', '--run', runId], {
    cwd: outside, env: f.env, stdout: 'pipe', stderr: 'pipe',
  })
  expect(named.exitCode).toBe(0)
  expect(named.stdout.toString()).toContain('issue #1')
})

test('decide from another repo does not reach the first repo run', () => {
  // Spec testing item 16, mandatory: the cross-repo shape of #21 through the
  // argv path a worker actually types. Both repos share one state dir and one
  // session — the situation the live ledger was in when #21 was hit.
  const a = started()
  expect(hpipe([...TASK], a).code).toBe(0)

  const b: Fixture = { ...a, repo: tempDir('hpipe-argv-repo-b-') }
  git(['init', '-q'], b.repo)
  mkdirSync(join(b.repo, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(b.repo, '.claude', 'agents', 'core-dev.md'), '# core-dev\n')
  expect(hpipe(['start', 'repo b'], b).code).toBe(0)

  const r = hpipe(['decide', '--task', 't1', '--question', 'q', '--recommend', 'r'], b)
  expect(r.code).toBe(1)
  expect(r.out).not.toContain('opened decision')
})
