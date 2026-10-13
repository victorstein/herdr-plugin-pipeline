import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beadsExportPath, beadsHome, beadsRoot } from './beads-project'
import { type Bounded, runBounded } from './spawn'

const GIT_TIMEOUT_MS = 5_000
const EXPORT_IN_STORE = '.beads/issues.jsonl'
const AUTHOR_NAME = 'hpipe'
const AUTHOR_EMAIL = 'hpipe@localhost'
/** Only the export is history: the Dolt data is binary and large, and everything else is a lock or scratch. */
const EXCLUDE = `/*\n!/.beads/\n/.beads/*\n!/${EXPORT_IN_STORE}\n`

export interface HistoryOptions {
  env?: Record<string, string | undefined>
  log?: (message: string) => void
}

/** Per store, the failure last logged: a lasting one is reported once, not on every write. */
const lastLogged = new Map<string, string>()

/**
 * No GIT_* variable of the caller's survives, since a GIT_DIR or GIT_INDEX_FILE
 * leaked from a hook would aim the commit at another repo; nor does the user's
 * config, whose signing, hooks or fsmonitor could prompt or block.
 */
function historyGitEnv(stateDir: string, base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('GIT_')))
  return {
    ...env,
    GIT_CEILING_DIRECTORIES: beadsRoot(stateDir),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    GIT_TERMINAL_PROMPT: '0',
  }
}

function gitFailure(args: string[], out: Bounded): string {
  if (out.timedOut) return `git ${args[0]} was killed after ${GIT_TIMEOUT_MS / 1000}s`
  return `git ${args[0]} exited ${out.code}: ${out.stderr.trim() || out.stdout.trim()}`
}

/** Null once the export as it stands is committed, else why it is not. */
async function commitExport(home: string, env: Record<string, string | undefined>, message: string): Promise<string | null> {
  // The -c flags repeat, for a git older than 2.32 that ignores GIT_CONFIG_GLOBAL,
  // the two settings that could block a commit.
  const git = (args: string[]) => runBounded(
    ['git', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: home, env, timeoutMs: GIT_TIMEOUT_MS },
  )
  if (!existsSync(join(home, '.git'))) {
    const init = ['init', '--quiet', '--initial-branch=main']
    const initialised = await git(init)
    if (initialised.code !== 0) return gitFailure(init, initialised)
    mkdirSync(join(home, '.git', 'info'), { recursive: true })
    writeFileSync(join(home, '.git', 'info', 'exclude'), EXCLUDE)
  }
  const add = ['add', '--force', '--', EXPORT_IN_STORE]
  const added = await git(add)
  if (added.code !== 0) return gitFailure(add, added)
  const diff = ['diff', '--cached', '--quiet', '--', EXPORT_IN_STORE]
  const staged = await git(diff)
  if (staged.code === 0) return null
  if (staged.code !== 1) return gitFailure(diff, staged)
  const commit = ['commit', '--quiet', '-m', message]
  const committed = await git(commit)
  return committed.code === 0 ? null : gitFailure(commit, committed)
}

/**
 * Commits the store's export to the store's own git repo, making the repo on
 * first use, so bv's history view has commits to read: with none, its `git log`
 * fails. The repo must not exist before `bd init` runs, which inside one commits
 * its own files as the user and sets `beads.role`. Never throws: the history
 * only serves the board, and no bd write or tick may fail for it.
 */
export async function recordBeadsHistory(
  stateDir: string, slug: string, message: string, options: HistoryOptions = {},
): Promise<void> {
  if (!existsSync(beadsExportPath(stateDir, slug))) return
  const home = beadsHome(stateDir, slug)
  let failure: string | null
  try {
    failure = await commitExport(home, historyGitEnv(stateDir, options.env ?? process.env), message)
  } catch (error) {
    failure = String(error)
  }
  if (failure === null) {
    lastLogged.delete(home)
    return
  }
  if (lastLogged.get(home) !== failure) {
    const log = options.log ?? console.error
    log(`[pipeline] beads ${slug}: history not recorded (${failure}); ` +
      'the board\'s history view lags until a later change records it')
  }
  lastLogged.set(home, failure)
}
