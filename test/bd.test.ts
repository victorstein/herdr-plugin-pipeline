import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bd, isBdFailure } from '../src/lib/bd'
import { beadsExportPath, beadsHome } from '../src/lib/beads-project'
import { processStartedAtMs } from '../src/lib/pidfile'

const SLUG = 'repo-abc123'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bd-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const home = (): string => beadsHome(dir, SLUG)
const logLines = (prefix: string): string[] =>
  readFileSync(join(dir, 'bd.log'), 'utf8').split('\n').filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length))
const withTmp = (line: string): string => line.replace(/\S*\.hpipe-[0-9a-f-]+\.md/g, '<tmp>')

function scriptBd(body: string): string {
  const path = join(dir, `bd-${Math.random().toString(36).slice(2)}`)
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/**
 * Records each call's argv, cwd and env, and the text of any file it is handed:
 * Bd deletes its temp files as soon as the call returns, so the text can only be
 * caught inside the call. Warns on stderr the way bd does outside git.
 */
function recordingBd(responses: Record<string, unknown> = {}): string {
  return scriptBd(`
import { appendFileSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const out = (line) => appendFileSync(${JSON.stringify(join(dir, 'bd.log'))}, line + '\\n')
out('argv: ' + argv.join(' '))
out('env: cwd=' + process.cwd() + ' BEADS_DIR=' + process.env.BEADS_DIR + ' CEILING=' + process.env.GIT_CEILING_DIRECTORIES)
for (const flag of ['--body-file', '--file', '--reason-file']) {
  const i = argv.indexOf(flag)
  if (i !== -1) out('file: ' + readFileSync(argv[i + 1], 'utf8').trim())
}
process.stderr.write('warning: beads.role is not set\\n')
process.stdout.write(JSON.stringify(${JSON.stringify(responses)}[argv[3]] ?? {}))
`)
}

async function liveHolder(): Promise<string> {
  return JSON.stringify({ pid: process.pid, started_at_ms: await processStartedAtMs(process.pid), token: 'someone' })
}

test('every call runs bd --json --actor hpipe in the store dir, with BEADS_DIR and the git ceiling', async () => {
  const bd = new Bd({
    stateDir: dir, slug: SLUG, lockWaitMs: 0,
    bin: recordingBd({ show: [{ id: 'hp-1', title: 'One', status: 'open' }] }),
  })
  expect(await bd.show('hp-1')).toEqual({ id: 'hp-1', title: 'One', status: 'open' })
  expect(logLines('argv: ')).toEqual(['--json --actor hpipe show hp-1 --include-comments --include-dependents'])
  expect(logLines('env: ')).toEqual([
    `cwd=${realpathSync(home())} BEADS_DIR=${join(home(), '.beads')} CEILING=${join(dir, 'beads')}`,
  ])
})

test('each method sends the argv of spec §2, and the files it hands bd hold the text it was given', async () => {
  const bd = new Bd({
    stateDir: dir, slug: SLUG, lockWaitMs: 0, exportAfterWrites: false,
    bin: recordingBd({ create: { id: 'hp-7', title: 'Fix the tile' } }),
  })
  expect(await bd.create({
    title: 'Fix the tile', body: 'Body text.\n', acceptance: 'It reads Bar.',
    labels: ['pipeline:tier-light', 'ui'], depsDiscoveredFrom: 'hp-1',
  })).toEqual({ id: 'hp-7' })
  expect(await bd.claim('hp-7')).toEqual({ ok: true })
  expect(await bd.update('hp-7', {
    status: 'open', assignee: '', addLabels: ['phase:plan'], removeLabels: ['phase:spec'],
  })).toEqual({ ok: true })
  expect(await bd.reopen('hp-7')).toEqual({ ok: true })
  expect(await bd.comment('hp-7', 'A ruling.\n')).toEqual({ ok: true })
  expect(await bd.depAdd('hp-7', 'hp-1')).toEqual({ ok: true })
  expect(await bd.close('hp-7', 'merged in PR #4 (abc1234)', { force: true })).toEqual({ ok: true })

  expect(logLines('argv: ').map(withTmp)).toEqual([
    '--json --actor hpipe create --title Fix the tile --body-file <tmp> --acceptance It reads Bar. ' +
      '-l pipeline:tier-light -l ui --deps discovered-from:hp-1',
    '--json --actor hpipe update hp-7 --claim',
    '--json --actor hpipe update hp-7 -s open --assignee  --add-label phase:plan --remove-label phase:spec',
    '--json --actor hpipe reopen hp-7',
    '--json --actor hpipe comment hp-7 --file <tmp>',
    '--json --actor hpipe dep add hp-7 hp-1 --type blocks',
    '--json --actor hpipe close hp-7 --reason-file <tmp> --force',
  ])
  expect(logLines('file: ')).toEqual(['Body text.', 'A ruling.', 'merged in PR #4 (abc1234)'])
  expect(readdirSync(home()).filter((name) => name.startsWith('.hpipe-'))).toEqual([])
})

test('an update with nothing to change spawns nothing', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd() })
  expect(await bd.update('hp-1', {})).toEqual({ ok: true })
  expect(existsSync(join(dir, 'bd.log'))).toBe(false)
})

test('a refusal carries bd\'s JSON error from stdout, ignoring the stderr warning', async () => {
  const refusing = scriptBd(`
process.stdout.write(JSON.stringify({ error: 'cannot close hp-1: assignee is "bob", actor is "hpipe"' }))
process.stderr.write('warning: beads.role is not set\\n')
process.exit(1)
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: refusing })
  expect(await bd.close('hp-1', 'merged', { force: false }))
    .toEqual({ reason: 'exit', error: 'cannot close hp-1: assignee is "bob", actor is "hpipe"' })
})

test('with no JSON error the failure is stderr without the beads.role warning', async () => {
  const locked = scriptBd(`
process.stderr.write('warning: beads.role is not set\\nError: database is locked\\n')
process.exit(1)
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: locked })
  expect(await bd.claim('hp-1')).toEqual({ reason: 'exit', error: 'Error: database is locked' })
})

test('bd 1.3.1\'s foreign-close refusal on stderr comes through without its warning block', async () => {
  const refusing = scriptBd(`
process.stderr.write([
  'warning: beads.role not configured (GH#2950).',
  '  Fix: git config beads.role maintainer',
  '  Or:  git config beads.role contributor',
  'Warning: could not compute repository ID: not a git repository',
  'cannot close hp-1: assignee is "hpipe", actor is "bob"; reclaim or use --force to override',
  '',
].join('\\n'))
process.exit(1)
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: refusing })
  expect(await bd.close('hp-1', 'merged', { force: false })).toEqual({
    reason: 'exit',
    error: 'cannot close hp-1: assignee is "hpipe", actor is "bob"; reclaim or use --force to override',
  })
})

test('a JSON error envelope on stderr is read like one on stdout', async () => {
  const refusing = scriptBd(`
process.stderr.write(JSON.stringify({ error: 'no issue found matching "hp-9"' }))
process.exit(1)
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: refusing })
  expect(await bd.show('hp-9')).toEqual({ reason: 'exit', error: 'no issue found matching "hp-9"' })
})

test('a close as hpipe passes a bd that refuses every other actor', async () => {
  const guarded = scriptBd(`
const argv = process.argv.slice(2)
const actor = argv[argv.indexOf('--actor') + 1]
if (argv.includes('close') && actor !== 'hpipe') {
  process.stdout.write(JSON.stringify({ error: 'cannot close hp-1: assignee is "hpipe", actor is "' + actor + '"' }))
  process.exit(1)
}
process.stdout.write('{}')
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: guarded })
  expect(await bd.close('hp-1', 'merged in PR #1 (abc)', { force: false })).toEqual({ ok: true })
})

test('a write exports inside its hold; a failed export leaves export.dirty, which the next hold clears first', async () => {
  const flaky = scriptBd(`
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'bd.log'))}, 'call: ' + argv.slice(3).join(' ') + '\\n')
const failedOnce = ${JSON.stringify(join(dir, 'export-failed-once'))}
if (argv[3] === 'export' && !existsSync(failedOnce)) {
  writeFileSync(failedOnce, '')
  process.stderr.write('disk full\\n')
  process.exit(1)
}
process.stdout.write('{}')
`)
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: flaky })
  const exportLine = `export -o ${beadsExportPath(dir, SLUG)}`

  expect(await bd.claim('hp-1')).toEqual({ ok: true })
  expect(existsSync(join(home(), 'export.dirty'))).toBe(true)

  expect(await bd.reopen('hp-1')).toEqual({ ok: true })
  expect(logLines('call: ')).toEqual(['update hp-1 --claim', exportLine, exportLine, 'reopen hp-1', exportLine])
  expect(existsSync(join(home(), 'export.dirty'))).toBe(false)
})

test('without export after writes, a write marks the export dirty and exportNow clears it', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, exportAfterWrites: false, bin: recordingBd() })
  expect(await bd.claim('hp-1')).toEqual({ ok: true })
  expect(await bd.reopen('hp-1')).toEqual({ ok: true })
  expect(existsSync(join(home(), 'export.dirty'))).toBe(true)

  expect(await bd.exportNow()).toEqual({ ok: true })
  expect(logLines('argv: ')).toEqual([
    '--json --actor hpipe update hp-1 --claim',
    '--json --actor hpipe reopen hp-1',
    `--json --actor hpipe export -o ${beadsExportPath(dir, SLUG)}`,
  ])
  expect(existsSync(join(home(), 'export.dirty'))).toBe(false)
})

test('refreshExport re-exports only when the export is dirty', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd() })
  expect(await bd.refreshExport()).toEqual({ ok: true })
  expect(existsSync(join(dir, 'bd.log'))).toBe(false)

  mkdirSync(home(), { recursive: true })
  writeFileSync(join(home(), 'export.dirty'), '1\n')
  expect(await bd.refreshExport()).toEqual({ ok: true })
  expect(logLines('argv: ')).toEqual([`--json --actor hpipe export -o ${beadsExportPath(dir, SLUG)}`])
})

test('initStore runs bd init, the counter config and a first export, in that order', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd() })
  expect(await bd.initStore('hp')).toEqual({ ok: true })
  expect(logLines('argv: ')).toEqual([
    '--json --actor hpipe init --prefix hp --skip-agents --skip-hooks --non-interactive',
    '--json --actor hpipe config set issue_id_mode counter',
    `--json --actor hpipe export -o ${beadsExportPath(dir, SLUG)}`,
  ])
})

test('the supervisor\'s try-lock gives up at once on a live holder; the CLI waits, then gives up', async () => {
  mkdirSync(home(), { recursive: true })
  writeFileSync(join(home(), 'hpipe.lock'), await liveHolder())
  const bin = recordingBd()

  expect(await new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin }).claim('hp-1'))
    .toEqual({ reason: 'busy', error: 'Beads is busy, retry' })

  const started = Date.now()
  expect(await new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 300, bin }).claim('hp-1'))
    .toEqual({ reason: 'busy', error: 'Beads is busy, retry' })
  expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  expect(existsSync(join(dir, 'bd.log'))).toBe(false)
})

test('a CLI waiting on the lock gets it once the holder lets go, and releases it after', async () => {
  mkdirSync(home(), { recursive: true })
  const lock = join(home(), 'hpipe.lock')
  writeFileSync(lock, await liveHolder())
  setTimeout(() => rmSync(lock), 150)

  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 2_000, bin: recordingBd() })
  expect(await bd.claim('hp-1')).toEqual({ ok: true })
  expect(existsSync(lock)).toBe(false)
})

test('a lock whose holder is dead is reclaimed, by a try-lock too', async () => {
  const exited = Bun.spawn(['true'])
  await exited.exited
  mkdirSync(home(), { recursive: true })
  writeFileSync(join(home(), 'hpipe.lock'), JSON.stringify({ pid: exited.pid, started_at_ms: 1, token: 'dead' }))

  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd() })
  expect(await bd.claim('hp-1')).toEqual({ ok: true })
})

test('a bd that hangs is killed at the timeout and reported as one', async () => {
  const hanging = scriptBd('await Bun.sleep(10_000)')
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, timeoutMs: 200, bin: hanging })
  const started = Date.now()
  const result = await bd.show('hp-1')
  expect(isBdFailure(result) ? result.reason : 'no failure').toBe('timeout')
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('a show that prints no bead is an output failure, not a crash', async () => {
  const bd = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0, bin: recordingBd({ show: [] }) })
  expect(await bd.show('hp-404')).toEqual({ reason: 'output', error: 'bd show hp-404 printed no bead' })
})

test('readExport parses the issue lines of the export and skips the rest', () => {
  mkdirSync(join(home(), '.beads'), { recursive: true })
  writeFileSync(beadsExportPath(dir, SLUG), [
    JSON.stringify({
      _type: 'issue', id: 'hp-1', title: 'One', status: 'in_progress', assignee: 'hpipe',
      labels: ['phase:plan'], dependencies: [{ issue_id: 'hp-1', depends_on_id: 'hp-0', type: 'blocks' }],
      comments: [{ id: 'c1', text: 'hi [hpipe t1/d1/asked]' }],
    }),
    JSON.stringify({ _type: 'memory', key: 'k', value: 'v' }),
    'not json',
    '',
  ].join('\n'))

  const beads = new Bd({ stateDir: dir, slug: SLUG, lockWaitMs: 0 }).readExport()
  expect(beads.map((b) => b.id)).toEqual(['hp-1'])
  expect(beads[0]).toMatchObject({ status: 'in_progress', assignee: 'hpipe', labels: ['phase:plan'] })
  expect(beads[0]?.dependencies?.[0]).toMatchObject({ depends_on_id: 'hp-0', type: 'blocks' })
  expect(beads[0]?.comments?.[0]?.text).toContain('[hpipe t1/d1/asked]')
  expect(new Bd({ stateDir: join(dir, 'none'), slug: SLUG, lockWaitMs: 0 }).readExport()).toEqual([])
})
