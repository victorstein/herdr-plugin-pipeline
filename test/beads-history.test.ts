import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordBeadsHistory } from '../src/lib/beads-history'
import { beadsExportPath, beadsHome } from '../src/lib/beads-project'

const SLUG = 'repo-abc123'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'beads-history-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const home = (): string => beadsHome(dir, SLUG)
const ISSUE = (status: string): string => `{"_type":"issue","id":"hp-1","title":"One","status":"${status}"}\n`

/** Reads git without the user's config, so a test's assertions cannot depend on it. */
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env },
  })
  if (!proc.success) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

const lines = (text: string): string[] => (text === '' ? [] : text.split('\n'))
const commits = (cwd: string): string[] => lines(git(cwd, ['log', '--format=%an <%ae>|%s']))

function writeExport(text: string): void {
  mkdirSync(join(home(), '.beads'), { recursive: true })
  writeFileSync(beadsExportPath(dir, SLUG), text)
}

/** The files bd 1.3.1 and hpipe leave in a store beside the export. */
function storeClutter(): void {
  mkdirSync(join(home(), '.beads', 'embeddeddolt'), { recursive: true })
  writeFileSync(join(home(), '.beads', 'embeddeddolt', 'chunk'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(join(home(), '.beads', 'embeddeddolt.gate.lock'), '')
  writeFileSync(join(home(), '.beads', 'metadata.json'), '{}\n')
  writeFileSync(join(home(), '.beads', 'config.yaml'), '# bd\n')
  writeFileSync(join(home(), '.beads.gate.lock'), '')
  writeFileSync(join(home(), '.gitignore'), '.dolt/\n')
  writeFileSync(join(home(), 'project.json'), '{}\n')
  writeFileSync(join(home(), 'hpipe.lock'), '{}\n')
  writeFileSync(join(home(), 'export.dirty'), '1\n')
}

function enclosingRepo(): void {
  writeFileSync(join(dir, 'dotfile'), 'mine\n')
  git(dir, ['init', '-q', '--initial-branch=main'])
  git(dir, ['add', 'dotfile'])
  git(dir, ['-c', 'user.name=Me', '-c', 'user.email=me@example.com', 'commit', '-qm', 'mine'])
}

test('the first record makes the store its own repo, whose one commit by hpipe holds only the export', async () => {
  writeExport(ISSUE('open'))
  storeClutter()
  await recordBeadsHistory(dir, SLUG, 'init')
  expect(commits(home())).toEqual(['hpipe <hpipe@localhost>|init'])
  expect(lines(git(home(), ['ls-files']))).toEqual(['.beads/issues.jsonl'])
  expect(git(home(), ['status', '--porcelain', '--untracked-files=all'])).toBe('')
})

test('an export that has not changed adds no commit, and one that has adds one', async () => {
  writeExport(ISSUE('open'))
  await recordBeadsHistory(dir, SLUG, 'init')
  await recordBeadsHistory(dir, SLUG, 'refresh')
  writeExport(ISSUE('in_progress'))
  await recordBeadsHistory(dir, SLUG, 'update hp-1')
  expect(commits(home()).map((c) => c.split('|')[1])).toEqual(['update hp-1', 'init'])
})

test('with no export yet there is nothing to record, so no repo is made', async () => {
  mkdirSync(home(), { recursive: true })
  await recordBeadsHistory(dir, SLUG, 'init')
  expect(existsSync(join(home(), '.git'))).toBe(false)
})

test('a work tree enclosing the state dir gets no commit and nothing staged', async () => {
  enclosingRepo()
  writeExport(ISSUE('open'))
  await recordBeadsHistory(dir, SLUG, 'init')
  expect(commits(dir)).toEqual(['Me <me@example.com>|mine'])
  expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('')
  expect(commits(home())).toHaveLength(1)
})

test('git state leaked into the environment cannot point the commit at another repo', async () => {
  enclosingRepo()
  writeExport(ISSUE('open'))
  await recordBeadsHistory(dir, SLUG, 'init', {
    env: { ...process.env, GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir, GIT_INDEX_FILE: join(dir, '.git', 'index') },
  })
  expect(commits(dir)).toEqual(['Me <me@example.com>|mine'])
  expect(git(dir, ['diff', '--cached', '--name-only'])).toBe('')
  expect(commits(home())).toHaveLength(1)
})

test('the user\'s own git config — signing, hooks, identity — does not reach the store', async () => {
  const userHome = join(dir, 'user-home')
  const hooks = join(userHome, 'hooks')
  mkdirSync(hooks, { recursive: true })
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch ${join(userHome, `ran-${hook}`)}\nexit 1\n`)
    chmodSync(join(hooks, hook), 0o755)
  }
  writeFileSync(join(userHome, '.gitconfig'), [
    '[user]', '  name = Someone Else', '  email = someone@example.com',
    '[commit]', '  gpgSign = true', '[gpg]', '  program = /usr/bin/false',
    '[core]', `  hooksPath = ${hooks}`, '',
  ].join('\n'))
  writeExport(ISSUE('open'))
  const logged: string[] = []
  await recordBeadsHistory(dir, SLUG, 'init', {
    env: { ...process.env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config') },
    log: (message) => { logged.push(message) },
  })
  expect(logged).toEqual([])
  expect(commits(home())).toEqual(['hpipe <hpipe@localhost>|init'])
  expect(existsSync(join(userHome, 'ran-pre-commit'))).toBe(false)
})

test('a git failure is logged once, never thrown, and logged again only after a success', async () => {
  writeExport(ISSUE('open'))
  writeFileSync(join(home(), '.git'), 'not a repository\n')
  const logged: string[] = []
  const log = (message: string): void => { logged.push(message) }
  await recordBeadsHistory(dir, SLUG, 'update hp-1', { log })
  await recordBeadsHistory(dir, SLUG, 'update hp-1', { log })
  expect(logged).toHaveLength(1)
  expect(logged[0]).toContain(`beads ${SLUG}: history not recorded`)

  rmSync(join(home(), '.git'))
  await recordBeadsHistory(dir, SLUG, 'refresh', { log })
  expect(logged).toHaveLength(1)
  rmSync(join(home(), '.git'), { recursive: true })
  writeFileSync(join(home(), '.git'), 'not a repository\n')
  await recordBeadsHistory(dir, SLUG, 'update hp-1', { log })
  expect(logged).toHaveLength(2)
})
