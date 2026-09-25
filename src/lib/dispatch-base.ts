import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Task } from './types'

/**
 * The commit a new worker worktree is cut from, fetched just before a dispatch
 * names it. Local `main` is whatever the orchestrator last pulled, so a task
 * dispatched after its dependency merged upstream was cut without that code.
 * Measured on a live run (#87). The pipeline fetches rather than asking the
 * orchestrator to, because an instruction can be skipped and this cannot.
 *
 * The base is the commit, not the ref: `herdr worktree create --base
 * origin/main` leaves the new branch tracking `origin/main`, where a bare
 * `git push` under `push.default=upstream` lands on main. A commit start point
 * sets no upstream. Measured on herdr 0.9.0.
 */
export interface DispatchBase {
  /** Null only when no candidate ref resolves; the ref name is then all there is to pass. */
  commit: string | null
  ref: string
  /** Why the fetch did not happen or failed; `ref` is then only as new as the last fetch. */
  fetchError: string | null
}

// The supervisor's tick is serial, so every second here holds up every run. One
// budget covers every network call a dispatch makes, not each call.
const FETCH_TIMEOUT_MS = 15_000
// Several tasks dispatched in one burst share a fetch, and a tick that loses its
// save to a CLI write does not pay for a second one.
const CACHE_TTL_MS = 60_000

interface GitResult { code: number; out: string; err: string; timedOut: boolean }

interface Network { env: Record<string, string | undefined>; deadline: number }

async function git(repoRoot: string, args: string[], network?: Network): Promise<GitResult> {
  if (network !== undefined && Date.now() >= network.deadline) {
    return { code: -1, out: '', err: '', timedOut: true }
  }
  try {
    // Its own process group, so a timeout kills the ssh child with it; an
    // orphaned transport would hold the stdout pipe open. Having no controlling
    // terminal also stops ssh prompting on /dev/tty.
    const proc = Bun.spawn(['git', '-C', repoRoot, ...args], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      detached: network !== undefined, env: network?.env,
    })
    let timedOut = false
    const timer = network === undefined ? null : setTimeout(() => {
      timedOut = true
      try { process.kill(-proc.pid, 'SIGKILL') } catch { proc.kill('SIGKILL') }
    }, network.deadline - Date.now())
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (timer !== null) clearTimeout(timer)
    return { code, out, err, timedOut }
  } catch {
    return { code: -1, out: '', err: 'git could not be run', timedOut: false }
  }
}

function failureReason(result: GitResult): string {
  if (result.timedOut) return `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
  const lastLine = result.err.split('\n').map((line) => line.trim()).filter(Boolean).pop()
  return lastLine ?? `git exited ${result.code}`
}

/** A user's own ssh command wins; otherwise ssh must fail rather than prompt for a passphrase or host key. */
async function networkEnv(repoRoot: string): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return env
  const configured = await git(repoRoot, ['config', '--get', 'core.sshCommand'])
  if (configured.code === 0 && configured.out.trim().length > 0) return env
  return { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
}


const advertisedDefaults = new Map<string, string>()
const unansweredLookups = new Map<string, number>()

/**
 * Dispatch asks from the main checkout and adoption from a linked worktree, so
 * the detection caches are keyed on the repository both share, not the path
 * asked from; otherwise every worktree pays for its own lookup.
 */
async function repoKey(checkoutPath: string): Promise<string> {
  const commonDir = await git(checkoutPath, ['rev-parse', '--git-common-dir'])
  if (commonDir.code !== 0) return checkoutPath
  try {
    return realpathSync(resolve(checkoutPath, commonDir.out.trim()))
  } catch {
    return checkoutPath
  }
}

/** Null declines the network call, leaving the lookup unanswered. */
type OpenNetwork = (cacheKey: string) => Promise<Network | null>

/**
 * `refs/remotes/origin/HEAD` exists only in a clone; a repo created locally and
 * pushed never gets one, so the remote is asked instead of assuming `main`.
 */
async function defaultBranch(
  repoRoot: string, openNetwork: OpenNetwork,
): Promise<{ branch: string; error: string | null }> {
  const remoteHead = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const local = remoteHead.out.trim()
  if (remoteHead.code === 0 && local.startsWith('origin/')) {
    return { branch: local.slice('origin/'.length), error: null }
  }
  const cacheKey = await repoKey(repoRoot)
  const known = advertisedDefaults.get(cacheKey)
  if (known !== undefined) return { branch: known, error: null }

  const network = await openNetwork(cacheKey)
  if (network === null) return { branch: 'main', error: 'the last lookup failed; not retried yet' }
  const advertised = await git(repoRoot, ['ls-remote', '--symref', 'origin', 'HEAD'], network)
  if (advertised.code !== 0) return { branch: 'main', error: failureReason(advertised) }
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(advertised.out)
  if (match === null) return { branch: 'main', error: null }
  advertisedDefaults.set(cacheKey, match[1]!)
  return { branch: match[1]!, error: null }
}

/**
 * The branch dispatch cuts worktrees from, for a caller that needs the name
 * rather than a fetch. Null when origin exists but cannot say: guessing `main`
 * there could name a stale branch that is not the default at all.
 *
 * With no origin, dispatch falls back to local `main`, and so does this.
 *
 * A failed lookup is not retried for a while: the caller runs on the tick, and
 * an unreachable remote would otherwise cost the full timeout on every one.
 * `onFailure` hears each lookup that actually failed, not each cooled-down null.
 */
export async function mainlineBranch(
  repoRoot: string, onFailure: (reason: string) => void = () => {}, now: () => number = Date.now,
): Promise<string | null> {
  const origin = await git(repoRoot, ['remote', 'get-url', 'origin'])
  if (origin.code !== 0) return 'main'

  const attempt: { cacheKey: string | null } = { cacheKey: null }
  const found = await defaultBranch(repoRoot, async (cacheKey) => {
    const failedAt = unansweredLookups.get(cacheKey)
    if (failedAt !== undefined && now() - failedAt < CACHE_TTL_MS) return null
    attempt.cacheKey = cacheKey
    return { env: await networkEnv(repoRoot), deadline: Date.now() + FETCH_TIMEOUT_MS }
  })
  if (found.error === null) return found.branch
  if (attempt.cacheKey !== null) {
    unansweredLookups.set(attempt.cacheKey, now())
    onFailure(found.error)
  }
  return null
}

async function fetchBase(repoRoot: string): Promise<DispatchBase> {
  let branch = 'main'
  let fetchError: string | null
  const origin = await git(repoRoot, ['remote', 'get-url', 'origin'])
  if (origin.code !== 0) {
    fetchError = failureReason(origin)
  } else {
    const network = { env: await networkEnv(repoRoot), deadline: Date.now() + FETCH_TIMEOUT_MS }
    const found = await defaultBranch(repoRoot, async () => network)
    branch = found.branch
    fetchError = found.error
    if (fetchError === null) {
      const fetched = await git(repoRoot, ['fetch', '--quiet', 'origin', branch], network)
      if (fetched.code !== 0) fetchError = failureReason(fetched)
    }
  }

  const candidates: Array<[fullRef: string, ref: string]> = [
    [`refs/remotes/origin/${branch}`, `origin/${branch}`],
    [`refs/heads/${branch}`, branch],
  ]
  for (const [fullRef, ref] of candidates) {
    const resolved = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${fullRef}^{commit}`])
    if (resolved.code === 0) return { commit: resolved.out.trim(), ref, fetchError }
  }
  return { commit: null, ref: branch, fetchError }
}

const recentBases = new Map<string, { fetchedAt: number; base: DispatchBase }>()

async function containsAll(repoRoot: string, commit: string | null, merges: string[]): Promise<boolean> {
  if (commit === null) return merges.length === 0
  for (const merge of merges) {
    const ancestor = await git(repoRoot, ['merge-base', '--is-ancestor', merge, commit])
    if (ancestor.code !== 0) return false
  }
  return true
}

/**
 * `dependencyMerges` are the merge commits a cached base must already contain
 * to be reused; null means a dependency merged without one on record, so only a
 * new fetch will do. Checked by ancestry, not by time: GitHub's `mergedAt` is
 * truncated to the second and the local clock can run ahead of it, so a fetch
 * that started before the merge could otherwise pass as after it.
 */
export async function freshDispatchBase(
  repoRoot: string, dependencyMerges: string[] | null = [], now: () => number = Date.now,
): Promise<DispatchBase> {
  const startedAt = now()
  const recent = recentBases.get(repoRoot)
  if (
    recent !== undefined && dependencyMerges !== null &&
    startedAt - recent.fetchedAt < CACHE_TTL_MS &&
    await containsAll(repoRoot, recent.base.commit, dependencyMerges)
  ) {
    return recent.base
  }
  const base = await fetchBase(repoRoot)
  recentBases.set(repoRoot, { fetchedAt: startedAt, base })
  return base
}

export function forgetDispatchBases(): void {
  recentBases.clear()
  advertisedDefaults.clear()
  unansweredLookups.clear()
}

export function dependencyMerges(task: Task, tasks: Task[]): string[] | null {
  const merges: string[] = []
  for (const dependency of tasks.filter((t) => task.depends_on.includes(t.task_id))) {
    if (dependency.merge_commit) merges.push(dependency.merge_commit)
    else if (dependency.merged_at_ms !== null) return null
  }
  return merges
}

export function baseArgument(base: DispatchBase): string {
  return base.commit ?? base.ref
}

export function describeBase(base: DispatchBase): string {
  return base.fetchError === null
    ? `${base.ref} as just fetched`
    : `fetch failed: ${base.fetchError}; local ${base.ref}, may be stale`
}

export function baseLine(base: DispatchBase): string {
  return `base: ${baseArgument(base)} (${describeBase(base)})`
}
