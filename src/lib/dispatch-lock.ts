import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beadsSlug } from './beads-project'
import { processStartedAtMs } from './pidfile'
import { readJson, removeJsonIf, writeJsonExclusive, writeJsonIf } from './store'
import type { Run, SessionKey, Task } from './types'
import { unbriefedWorker } from './unstarted'

export type DispatchStep = 'base' | 'worktree' | 'pane' | 'bootstrap' | 'agent' | 'brief'
export type DispatchMode = 'task' | 'ready' | 'pane'

/**
 * One per repo, across sessions: bootstraps in worktrees of one repo share its
 * `.git/config`, so even different tasks wait. It records enough to clean up after
 * a dispatch killed with SIGKILL, which no trap sees.
 */
export interface DispatchLock {
  session: SessionKey
  run_id: string
  mode: DispatchMode
  task: string | null
  step: DispatchStep | null
  /** When `step` began. */
  since: number
  pid: number
  started_at_ms: number
  /** The bootstrap's process group while it runs: its leader's pid, and that leader's start time. */
  bootstrap: { pgid: number; started_at_ms: number } | null
}

export const dispatchLockPath = (stateDir: string, repoKey: string): string =>
  join(stateDir, 'dispatch', `${beadsSlug(repoKey)}.lock`)

export type StartedAt = (pid: number) => Promise<number | null>

/** `ps` reports whole seconds, as `supervisorState` allows for. */
const START_SLOP_MS = 1_000
/** How long a bootstrap's group has between SIGTERM and SIGKILL. */
export const STOP_GRACE_MS = 10_000

// `status.ts` reads this module, so its `ageMinutes` is not imported back.
const minutesSince = (since: number, now: number): number => Math.max(0, Math.floor((now - since) / 60_000))

async function startedAsRecorded(pid: number, recordedAtMs: number, startedAt: StartedAt): Promise<boolean> {
  const actual = await startedAt(pid)
  return actual !== null && Math.abs(actual - recordedAtMs) <= START_SLOP_MS
}

/** A lock whose pid is gone, or now names another process, is stale. */
export function lockIsLive(lock: DispatchLock, startedAt: StartedAt = processStartedAtMs): Promise<boolean> {
  return startedAsRecorded(lock.pid, lock.started_at_ms, startedAt)
}

function isDispatchLock(value: unknown): value is DispatchLock {
  const lock = value as Partial<DispatchLock> | null
  return typeof lock === 'object' && lock !== null && typeof lock.pid === 'number' &&
    typeof lock.started_at_ms === 'number' && typeof lock.session === 'string' && typeof lock.run_id === 'string'
}

const sameHolder = (current: unknown, holder: DispatchLock): boolean =>
  isDispatchLock(current) && current.pid === holder.pid && current.started_at_ms === holder.started_at_ms

/** Whether any process is left in the group, ours to signal or not. */
export function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // Already gone.
  }
}

/** SIGTERM first, so a bootstrap can stop what it started; SIGKILL once the grace is spent. */
export async function stopGroup(pgid: number, graceMs: number = STOP_GRACE_MS): Promise<void> {
  signalGroup(pgid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (groupExists(pgid) && Date.now() < deadline) await Bun.sleep(50)
  if (groupExists(pgid)) signalGroup(pgid, 'SIGKILL')
}

export interface LockDeps {
  startedAt: StartedAt
  groupExists: (pgid: number) => boolean
  stopGroup: (pgid: number) => Promise<void>
}

const REAL_LOCK_DEPS: LockDeps = { startedAt: processStartedAtMs, groupExists, stopGroup }

/** The lock this process holds. Every write is a compare-and-swap on the holder, so it never rewrites another's. */
export class HeldDispatchLock {
  constructor(readonly path: string, private current: DispatchLock) {}

  get record(): DispatchLock {
    return this.current
  }

  async at(task: string | null, step: DispatchStep | null, now: number = Date.now()): Promise<void> {
    await this.write({ ...this.current, task, step, since: now })
  }

  async bootstrapStarted(pgid: number, startedAtMs: number): Promise<void> {
    await this.write({ ...this.current, bootstrap: { pgid, started_at_ms: startedAtMs } })
  }

  async bootstrapEnded(): Promise<void> {
    await this.write({ ...this.current, bootstrap: null })
  }

  /** Synchronous, so a signal handler can call it on its way out. */
  release(): void {
    removeJsonIf(this.path, (current) => sameHolder(current, this.current))
  }

  private async write(next: DispatchLock): Promise<void> {
    const holder = this.current
    this.current = next
    await writeJsonIf(this.path, next, (current) => sameHolder(current, holder))
  }
}

export type LockTaken =
  | { ok: true; lock: HeldDispatchLock }
  | { ok: false; holder: DispatchLock }
  | { ok: false; refusal: string }

/**
 * A stale lock's bootstrap is stopped only when its group leader provably is the
 * one the lock recorded; a group that cannot be shown to be ours is left alone,
 * and the dispatch refuses rather than run a second bootstrap beside it.
 */
async function clearStale(path: string, stale: DispatchLock, deps: LockDeps): Promise<string | null> {
  const group = stale.bootstrap
  if (group !== null) {
    if (await startedAsRecorded(group.pgid, group.started_at_ms, deps.startedAt)) {
      await deps.stopGroup(group.pgid)
    } else if (deps.groupExists(group.pgid)) {
      return `process group ${group.pgid} may be an earlier dispatch's bootstrap: check \`ps -g ${group.pgid}\`, ` +
        'stop it, then run this again'
    }
  }
  removeJsonIf(path, (current) => sameHolder(current, stale))
  return null
}

const TAKE_ATTEMPTS = 3

export async function takeDispatchLock(
  stateDir: string, repoKey: string, wanted: DispatchLock, deps: LockDeps = REAL_LOCK_DEPS,
): Promise<LockTaken> {
  const path = dispatchLockPath(stateDir, repoKey)
  for (let attempt = 0; attempt < TAKE_ATTEMPTS; attempt++) {
    if (await writeJsonExclusive(path, wanted)) return { ok: true, lock: new HeldDispatchLock(path, wanted) }
    const existing = await readJson<unknown>(path)
    if (!isDispatchLock(existing)) {
      if (!existsSync(path)) continue
      return {
        ok: false,
        refusal: `the dispatch lock ${path} cannot be read; if no \`hpipe dispatch\` is running, delete it and run ` +
          'this again',
      }
    }
    if (await lockIsLive(existing, deps.startedAt)) return { ok: false, holder: existing }
    const refusal = await clearStale(path, existing, deps)
    if (refusal !== null) return { ok: false, refusal }
  }
  return { ok: false, refusal: `the dispatch lock ${path} kept changing hands; run this again` }
}

/** "t1 is being dispatched by pid 4242 (bootstrap, 3m)", for a refusal. */
export function holderLine(lock: DispatchLock, now: number): string {
  const where = lock.step === null ? '' : ` (${lock.step}, ${minutesSince(lock.since, now)}m)`
  const what = lock.task === null
    ? `a dispatch (${lock.mode === 'ready' ? '--ready' : lock.mode}) is under way by pid ${lock.pid}`
    : `${lock.task} is being dispatched by pid ${lock.pid}`
  return `${what}${where}, in session ${lock.session} (run ${lock.run_id})`
}

export interface DispatchLockReading { live: boolean; lock: DispatchLock }

/** By repo key. */
export type DispatchLocks = ReadonlyMap<string, DispatchLockReading>

export const NO_DISPATCHES: DispatchLocks = new Map()

/** One `ps` per lock found; with no dispatch running there is no lock and no `ps`. */
export async function readDispatchLocks(
  stateDir: string, repoKeys: Iterable<string>, startedAt: StartedAt = processStartedAtMs,
): Promise<DispatchLocks> {
  const readings = new Map<string, DispatchLockReading>()
  for (const repoKey of new Set(repoKeys)) {
    const lock = await readJson<unknown>(dispatchLockPath(stateDir, repoKey))
    if (isDispatchLock(lock)) readings.set(repoKey, { live: await lockIsLive(lock, startedAt), lock })
  }
  return readings
}

/**
 * The live dispatch that is this task's next move, or null. One that names the
 * task is; so is a `--ready` one for any task owed its brief, which it takes
 * before it lets go of the lock: a `dispatch --task` for it would be refused.
 */
export function dispatchUnderWay(locks: DispatchLocks, run: Run, task: Task): DispatchLock | null {
  const reading = locks.get(run.repo_key)
  if (reading === undefined || !reading.live) return null
  const { lock } = reading
  if (lock.session !== run.session || lock.run_id !== run.run_id) return null
  if (lock.task === task.task_id) return lock
  return lock.mode === 'ready' && unbriefedWorker(run, task) !== null ? lock : null
}

/** "`hpipe dispatch` (pid 4242) is at bootstrap for t1, started 3m ago". */
export function dispatchProgress(lock: DispatchLock, task: Task, hpipe: string, now: number): string {
  const command = lock.mode === 'ready' ? `\`${hpipe} dispatch --ready\`` : `\`${hpipe} dispatch\``
  const at = lock.task === null
    ? 'between tasks'
    : `at ${lock.step ?? 'its start'} for ${lock.task}, started ${minutesSince(lock.since, now)}m ago`
  const takes = lock.task === task.task_id ? '' : `; it takes ${task.task_id} before it ends`
  return `${command} (pid ${lock.pid}) is ${at}${takes}`
}

/** What status and the digest say instead of a dispatch step while one is under way. */
export function underWayClause(lock: DispatchLock, task: Task, hpipe: string, now: number): string {
  return `nothing for you — ${dispatchProgress(lock, task, hpipe, now)}`
}

export function staleDispatchLock(locks: DispatchLocks, run: Run): DispatchLock | null {
  const reading = locks.get(run.repo_key)
  return reading === undefined || reading.live ? null : reading.lock
}
