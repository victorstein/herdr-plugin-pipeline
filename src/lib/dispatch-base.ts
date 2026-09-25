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

// The supervisor's tick is serial, so every second here holds up every run.
const FETCH_TIMEOUT_MS = 15_000
// Several tasks dispatched in one burst share a fetch, and a tick that loses its
// save to a CLI write does not pay for a second one.
const CACHE_TTL_MS = 60_000

interface GitResult { code: number; out: string; err: string; timedOut: boolean }

async function git(
  repoRoot: string, args: string[], network?: { env: Record<string, string | undefined> },
): Promise<GitResult> {
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
    }, FETCH_TIMEOUT_MS)
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

/**
 * `refs/remotes/origin/HEAD` exists only in a clone; a repo created locally and
 * pushed never gets one, so the remote is asked instead of assuming `main`.
 */
async function defaultBranch(
  repoRoot: string, env: Record<string, string | undefined>,
): Promise<{ branch: string; error: string | null }> {
  const remoteHead = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const local = remoteHead.out.trim()
  if (remoteHead.code === 0 && local.startsWith('origin/')) {
    return { branch: local.slice('origin/'.length), error: null }
  }
  const known = advertisedDefaults.get(repoRoot)
  if (known !== undefined) return { branch: known, error: null }

  const advertised = await git(repoRoot, ['ls-remote', '--symref', 'origin', 'HEAD'], { env })
  if (advertised.code !== 0) return { branch: 'main', error: failureReason(advertised) }
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(advertised.out)
  if (match === null) return { branch: 'main', error: null }
  advertisedDefaults.set(repoRoot, match[1]!)
  return { branch: match[1]!, error: null }
}

async function fetchBase(repoRoot: string): Promise<DispatchBase> {
  let branch = 'main'
  let fetchError: string | null
  const origin = await git(repoRoot, ['remote', 'get-url', 'origin'])
  if (origin.code !== 0) {
    fetchError = failureReason(origin)
  } else {
    const env = await networkEnv(repoRoot)
    const found = await defaultBranch(repoRoot, env)
    branch = found.branch
    fetchError = found.error
    if (fetchError === null) {
      const fetched = await git(repoRoot, ['fetch', '--quiet', 'origin', branch], { env })
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

/**
 * `freshAfterMs` is when the task's newest dependency merged: a base fetched
 * before that lacks the dependency however recent it is, so it is fetched again.
 */
export async function freshDispatchBase(
  repoRoot: string, freshAfterMs = 0, now: () => number = Date.now,
): Promise<DispatchBase> {
  const startedAt = now()
  const recent = recentBases.get(repoRoot)
  if (recent !== undefined && startedAt - recent.fetchedAt < CACHE_TTL_MS && recent.fetchedAt >= freshAfterMs) {
    return recent.base
  }
  const base = await fetchBase(repoRoot)
  recentBases.set(repoRoot, { fetchedAt: startedAt, base })
  return base
}

export function forgetDispatchBases(): void {
  recentBases.clear()
  advertisedDefaults.clear()
}

export function dependenciesMergedAt(task: Task, tasks: Task[]): number {
  const merged = tasks
    .filter((t) => task.depends_on.includes(t.task_id))
    .map((t) => t.merged_at_ms ?? 0)
  return Math.max(0, ...merged)
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
