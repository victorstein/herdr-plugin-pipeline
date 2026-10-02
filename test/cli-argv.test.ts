import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeFakeBin, makeFakeBinSync } from './helpers/fake-bin'
import { cleanupFixtures, git, tempDir } from './helpers/git-worktree'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const PLUGIN_ROOT = join(import.meta.dir, '..')

afterEach(cleanupFixtures)

interface Fixture { repo: string; stateDir: string; env: Record<string, string> }

/**
 * Registering with `--issue` reads the issue's labels through `gh`, and this bin
 * stands in so the suite never shells out to the real `gh` on the machine
 * running it. It answers only the label read, with no labels, so any other gh
 * call a change adds fails loudly; a test exercising the label read replaces
 * `f.env.GH_BIN` with its own fake bin.
 */
function defaultGhBin(): string {
  const dir = tempDir('hpipe-argv-gh-default-')
  const path = join(dir, 'fake-gh')
  writeFileSync(path, `#!/usr/bin/env bun
const argv = process.argv.slice(2).join(' ')
if (/^issue view \\d+ --json labels$/.test(argv)) { console.log(JSON.stringify({ labels: [] })); process.exit(0) }
console.error('unstubbed: ' + argv)
process.exit(1)
`)
  chmodSync(path, 0o755)
  return path
}

/**
 * `hpipe start` checks bd and bv and sets up a Beads store, so the suite stands
 * in for both rather than touching the machine's own. Any bd call a change adds
 * that is not stubbed here fails loudly; a test exercising more of bd replaces
 * `f.env.BD_BIN` with its own fake bin.
 */
const BD_RESPONSES: Record<string, unknown> = {
  version: 'bd version 1.3.1 (Homebrew)\n',
  '--json --actor hpipe init': {},
  '--json --actor hpipe config set issue_id_mode counter': {},
  '--json --actor hpipe export': {},
}
const BV_RESPONSES: Record<string, unknown> = { '--version': 'bv v0.25.2\n' }

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
    GH_BIN: defaultGhBin(),
    BD_BIN: makeFakeBinSync(tempDir('hpipe-argv-bd-'), BD_RESPONSES),
    BV_BIN: makeFakeBinSync(tempDir('hpipe-argv-bv-'), BV_RESPONSES),
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
  expect(hpipe(['start', 'repo b', '--prefix', 'repob'], b).code).toBe(0)

  const r = hpipe(['decide', '--task', 't1', '--question', 'q', '--recommend', 'r'], b)
  expect(r.code).toBe(1)
  expect(r.out).not.toContain('opened decision')
})

test('a command that resolves a run is assumed to need the caller repo', () => {
  // The dispatcher keeps a deny-list, not an allow-list: `release` is not in it,
  // so it gets the repo lookup without being named. An allow-list that forgot a
  // command would hand it repoKey: null and silently reintroduce #21.
  const f = started()
  const outside = tempDir('hpipe-argv-denylist-')

  const resolving = Bun.spawnSync(['bun', 'run', CLI, 'release', '--task', 't1'], {
    cwd: outside, env: f.env, stdout: 'pipe', stderr: 'pipe',
  })
  expect(resolving.exitCode).toBe(1)
  expect(resolving.stdout.toString() + resolving.stderr.toString())
    .toContain('not inside a git repository')

  // `status` addresses no run, so it works from anywhere.
  const byId = Bun.spawnSync(['bun', 'run', CLI, 'status'], {
    cwd: outside, env: f.env, stdout: 'pipe', stderr: 'pipe',
  })
  expect(byId.exitCode).toBe(0)
})

const SUBCOMMANDS = [
  'start', 'task', 'brief', 'show', 'dispatch', 'status', 'drain', 'rewind', 'release',
  'decide', 'answer', 'tier', 'resume', 'abort', 'forget',
]

test('--help and -h print that subcommand\'s usage before any side effect, from anywhere', () => {
  // `hpipe start --help` used to start a real run titled "--help", and
  // `hpipe resume --help` looked up a run with that id.
  const f = fixture()
  const outside = tempDir('hpipe-argv-help-')

  for (const command of SUBCOMMANDS) {
    for (const helpFlag of ['--help', '-h']) {
      const proc = Bun.spawnSync(['bun', 'run', CLI, command, helpFlag], {
        cwd: outside, env: f.env, stdout: 'pipe', stderr: 'pipe',
      })
      const out = proc.stdout.toString() + proc.stderr.toString()
      expect(proc.exitCode, `${command} ${helpFlag}`).toBe(0)
      expect(out, `${command} ${helpFlag}`).toContain(`usage: hpipe ${command}`)
      expect(out).not.toContain('no such run')
      expect(out).not.toContain('not inside a git repository')
    }
  }
  expect(existsSync(join(f.stateDir, 'runs'))).toBe(false)
})

test('start --help inside a repo starts no run', () => {
  const f = fixture()
  const r = hpipe(['start', '--help'], f)
  expect(r.code).toBe(0)
  expect(existsSync(join(f.stateDir, 'runs'))).toBe(false)
})

test('the top-level usage names every subcommand, brief and show included', () => {
  const f = fixture()
  const help = hpipe(['--help'], f)
  expect(help.code).toBe(0)
  for (const command of SUBCOMMANDS) expect(help.out).toContain(`hpipe ${command}`)

  const unknown = hpipe(['frobnicate'], f)
  expect(unknown.code).toBe(1)
  expect(unknown.out).toContain('brief')
  expect(unknown.out).toContain('show')
})

test('bare hpipe prints the usage to stderr and fails; --help prints it to stdout and succeeds', () => {
  const f = fixture()
  const bare = Bun.spawnSync(['bun', 'run', CLI], { cwd: f.repo, env: f.env, stdout: 'pipe', stderr: 'pipe' })
  expect(bare.exitCode).toBe(1)
  expect(bare.stdout.toString()).toBe('')
  expect(bare.stderr.toString()).toContain('usage: hpipe')

  const help = Bun.spawnSync(['bun', 'run', CLI, '--help'], { cwd: f.repo, env: f.env, stdout: 'pipe', stderr: 'pipe' })
  expect(help.exitCode).toBe(0)
  expect(help.stdout.toString()).toContain('usage: hpipe')
})

test('a command named after an Object.prototype key is unknown, not a crash', () => {
  const r = hpipe(['constructor', '--help'], fixture())
  expect(r.code).toBe(1)
  expect(r.out).toContain('usage: hpipe <')
  expect(r.out).not.toContain('TypeError')
})

test('a help flag in a free-text value slot is that value, not a help request', () => {
  const f = started()
  expect(hpipe([...TASK], f).code).toBe(0)

  const r = hpipe(['decide', '--task', 't1', '--question', '-h', '--recommend', 'r'], f)
  expect(r.out).not.toContain('usage:')
  expect(r.out).toContain('opened decision')
})

function registeredTasks(f: Fixture): unknown[] {
  const runsDir = join(f.stateDir, 'runs', 'argv-fixture')
  return (JSON.parse(readFileSync(join(runsDir, readdirSync(runsDir)[0]!), 'utf8')) as {
    tasks: unknown[]
  }).tasks
}

test('a help flag in an identifier slot is a help request and registers nothing', () => {
  // Round 2 of #64: `task --branch -h` registered a real task on branch `-h`.
  const f = started()
  for (const helpFlag of ['-h', '--help']) {
    const r = hpipe(['task', '--branch', helpFlag, '--issue', '1', '--surface', 'core'], f)
    expect(r.code).toBe(0)
    expect(r.out).toContain('usage: hpipe task')
  }
  expect(registeredTasks(f)).toEqual([])
})

test('an identifier flag whose value looks like a flag is a usage error', () => {
  const f = started()
  for (const args of [
    ['task', '--branch', '-x', '--issue', '1', '--surface', 'core'],
    ['task', '--branch', '--issue', '1', '--surface', 'core'],
  ]) {
    const r = hpipe(args, f)
    expect(r.code, args.join(' ')).toBe(1)
    expect(r.out).toContain('--branch needs a value')
  }
  expect(registeredTasks(f)).toEqual([])
})

test('task --title --body-file files the issue through gh and registers it', async () => {
  const f = started()
  const binDir = tempDir('hpipe-argv-gh-')
  f.env.GH_BIN = await makeFakeBin(binDir, { 'issue create': 'https://github.com/o/r/issues/77\n' })
  writeFileSync(join(f.repo, 'brief.md'), 'Relabel the settings tile.\n')

  const r = hpipe(['task', '--branch', 'feat/tile', '--title', '-relabel the tile',
    '--body-file', 'brief.md', '--surface', 'core'], f)

  expect(r.code).toBe(0)
  expect(r.out).toContain('issue: #77 (filed)')
  expect(r.out).toContain('# feat/tile — issue #77')
  expect(await Bun.file(join(binDir, 'calls.log')).text()).toContain(
    `issue create --title -relabel the tile --body-file ${join(realpathSync(f.repo), 'brief.md')}`,
  )
  expect(registeredTasks(f)).toMatchObject([{ issue: 77 }])
})

test('task --title with its value missing does not file an issue named after the next flag', async () => {
  const f = started()
  const binDir = tempDir('hpipe-argv-gh-')
  f.env.GH_BIN = await makeFakeBin(binDir, { 'issue create': 'https://github.com/o/r/issues/78\n' })
  writeFileSync(join(f.repo, 'brief.md'), 'Relabel the settings tile.\n')

  const r = hpipe(['task', '--branch', 'feat/t', '--title', '--body-file', 'brief.md', '--surface', 'core'], f)

  expect(r.code).toBe(1)
  expect(r.out).toContain('the value after --title is missing')
  expect(existsSync(join(binDir, 'calls.log'))).toBe(false)
  expect(registeredTasks(f)).toEqual([])
})

async function withFakeHerdr(f: Fixture, responses: Record<string, unknown>): Promise<string> {
  const binDir = tempDir('hpipe-argv-herdr-')
  f.env.HERDR_BIN_PATH = await makeFakeBin(binDir, responses)
  return join(binDir, 'calls.log')
}

test('dispatch --task submits the brief through herdr agent prompt and waits for it', async () => {
  const f = started()
  expect(hpipe([...TASK], f).code).toBe(0)
  const log = await withFakeHerdr(f, { 'agent prompt': { result: {} } })

  const r = hpipe(['dispatch', '--task', 't1', '--pane', 'w1-2'], f)

  expect(r.code).toBe(0)
  expect(r.out).toContain('brief for t1 delivered to w1-2')
  const calls = await Bun.file(log).text()
  expect(calls).toStartWith('agent prompt w1-2 # smoke/one — issue #1')
  expect(calls).toContain('--wait --until working --until blocked --timeout')
})

test('dispatch --task carries herdr\'s own error code through a real failure envelope', async () => {
  const f = started()
  expect(hpipe([...TASK], f).code).toBe(0)
  await withFakeHerdr(f, {
    'agent prompt': { error: { code: 'agent_not_found', message: 'agent target w9-9 not found' } },
  })

  const r = hpipe(['dispatch', '--task', 't1', '--pane', 'w9-9'], f)

  expect(r.code).toBe(1)
  expect(r.out).toContain('agent_not_found')
  expect(r.out).not.toContain('unparseable')
})

test('dispatch needs exactly one of --task and --done', async () => {
  const f = started()
  expect(hpipe([...TASK], f).code).toBe(0)
  const log = await withFakeHerdr(f, { 'agent prompt': { result: {} } })

  for (const args of [['dispatch'], ['dispatch', '--done', '--task', 't1', '--pane', 'w1-2']]) {
    const r = hpipe(args, f)
    expect(r.code, args.join(' ')).toBe(1)
    expect(r.out).toContain('usage: hpipe dispatch')
  }
  expect(existsSync(log)).toBe(false)
  const runsDir = join(f.stateDir, 'runs', 'argv-fixture')
  const run = JSON.parse(readFileSync(join(runsDir, readdirSync(runsDir)[0]!), 'utf8')) as {
    intake_closed: boolean
  }
  expect(run.intake_closed).toBe(false)
})

test('task --tier reaches registration, and a pipeline:tier label read through gh overrides it', async () => {
  const f = started()
  const binDir = tempDir('hpipe-argv-gh-')
  f.env.GH_BIN = await makeFakeBin(binDir, {
    'issue view 1': { labels: [{ name: 'pipeline:tier-light' }] },
    'issue view 2': { labels: [] },
  })

  const labelled = hpipe([...TASK, '--tier', 'heavy'], f)
  expect(labelled.code).toBe(0)
  expect(labelled.out).toContain('tier: light (label pipeline:tier-light; --tier said heavy)')

  const flagged = hpipe(['task', '--branch', 'smoke/two', '--issue', '2', '--surface', 'core', '--tier', 'heavy'], f)
  expect(flagged.code).toBe(0)
  expect(flagged.out).toContain('tier: heavy (--tier)')
  expect(await Bun.file(join(binDir, 'calls.log')).text()).toContain('issue view 1 --json labels')
})

test('task records the caller pane from HERDR_PANE_ID in its first tier change', () => {
  const f = started()
  f.env.HERDR_PANE_ID = 'w4:p2'
  expect(hpipe(TASK, f).code).toBe(0)
  const [task] = registeredTasks(f) as Array<{ tier_history: Array<{ pane: string | null }> }>
  expect(task!.tier_history[0]!.pane).toBe('w4:p2')
})

test('task --tier with its value missing is a usage error', () => {
  const r = hpipe([...TASK, '--tier', '--files', 'src/'], started())
  expect(r.code).toBe(1)
  expect(r.out).toContain('--tier needs a value')
})

test('tier reads its positional tier and --why, and the caller pane from HERDR_PANE_ID', async () => {
  const f = fixture()
  f.env.HERDR_PANE_ID = 'w1:p1'
  const binDir = tempDir('hpipe-argv-gh-')
  f.env.GH_BIN = await makeFakeBin(binDir, { 'issue view': { labels: [] } })
  expect(hpipe(['start', 'argv fixture'], f).code).toBe(0)
  expect(hpipe([...TASK], f).out).toContain('tier: standard (default)')

  const raised = hpipe(['tier', '--task', 't1', 'heavy', '--why', 'touches the ledger schema'], f)
  expect(raised.code).toBe(0)
  expect(raised.out).toContain('t1: standard → heavy')

  // `start` made this pane the orchestrator's, so lowering from it is refused.
  const lowered = hpipe(['tier', '--task', 't1', 'light', '--why', 'smaller than it looked'], f)
  expect(lowered.code).toBe(1)
  expect(lowered.out).toContain('lowering a tier needs a human; run this from your own pane')
})

test('start sets up a Beads store once, and --prefix names its prefix without joining the title', () => {
  const f = fixture()
  const r = hpipe(['start', 'argv', 'fixture', '--prefix', 'argv'], f)
  expect(r.code).toBe(0)
  expect(r.out).toContain('beads: created')
  expect(r.out).toContain('with prefix argv')

  const runsDir = join(f.stateDir, 'runs', 'argv-fixture')
  const run = JSON.parse(readFileSync(join(runsDir, readdirSync(runsDir)[0]!), 'utf8')) as { title: string }
  expect(run.title).toBe('argv fixture')
  const slugs = readdirSync(join(f.stateDir, 'beads'))
  expect(slugs).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(f.stateDir, 'beads', slugs[0]!, 'project.json'), 'utf8')))
    .toMatchObject({ prefix: 'argv' })
})

test('start refuses on a bd older than 1.3.1 and opens no run', () => {
  const f = fixture()
  f.env.BD_BIN = makeFakeBinSync(tempDir('hpipe-argv-oldbd-'), { version: 'bd version 1.0.4 (Homebrew)\n' })
  const r = hpipe(['start', 'argv fixture'], f)
  expect(r.code).toBe(1)
  expect(r.out).toContain('bd 1.0.4 is older than 1.3.1')
  expect(existsSync(join(f.stateDir, 'runs', 'argv-fixture'))).toBe(false)
})

test('start with a --prefix that has no value refuses and opens no run', () => {
  const f = fixture()
  const r = hpipe(['start', 'argv fixture', '--prefix'], f)
  expect(r.code).toBe(1)
  expect(r.out).toContain('--prefix needs a value')
  expect(existsSync(join(f.stateDir, 'runs', 'argv-fixture'))).toBe(false)
})
