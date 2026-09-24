import {
  closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    return (await file.json()) as T
  } catch {
    return null
  }
}

async function writeTemp(path: string, value: unknown): Promise<string> {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`)
  return tmp
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  renameSync(await writeTemp(path, value), path)
}

export class LockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`timed out waiting for ${lockPath}`)
    this.name = 'LockTimeoutError'
  }
}

export interface LockTiming {
  /**
   * A holder only keeps the lock for one read and one rename, so a lock this old
   * belongs to a process that died inside that window.
   */
  staleMs: number
  /** Longer than `staleMs`, so a dead holder's lock is reclaimed before a waiter gives up. */
  waitMs: number
}

const DEFAULT_LOCK_TIMING: LockTiming = { staleMs: 2_000, waitMs: 3_000 }
const LOCK_POLL_MS = 5

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function tryAcquire(lockPath: string, token: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, token)
    closeSync(fd)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }
}

function readToken(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Removes the lock only if it still carries `token`. Checking the path and then
 * unlinking it could delete a lock someone took in between, so the lock is moved
 * aside first — one atomic step — and the token is checked on the copy nobody
 * else can reach. A lock that turns out to be someone else's is linked back,
 * which fails rather than overwrites if the path was taken meanwhile. That last
 * case needs three processes and a dead holder at once; its worst outcome is one
 * write outside the lock, which is what every write was before this lock existed.
 */
function removeLockIf(lockPath: string, token: string): void {
  const aside = `${lockPath}.${randomUUID()}.aside`
  try {
    renameSync(lockPath, aside)
  } catch {
    return
  }
  try {
    if (readToken(aside) === token) return
    try {
      linkSync(aside, lockPath)
    } catch {
      // EEXIST: a new holder already has the path, and theirs stands.
    }
  } finally {
    rmSync(aside, { force: true })
  }
}

function reclaimIfStale(lockPath: string, staleMs: number): void {
  let seen
  try {
    seen = statSync(lockPath)
  } catch {
    return
  }
  if (Date.now() - seen.mtimeMs < staleMs) return
  const staleToken = readToken(lockPath)
  if (staleToken !== null) removeLockIf(lockPath, staleToken)
}

/**
 * Serialises a short critical section across processes. Bounded on purpose: the
 * supervisor and hooks must never hang on a lock a crashed CLI left behind.
 */
export async function withFileLock<T>(
  path: string, critical: () => T | Promise<T>, timing: LockTiming = DEFAULT_LOCK_TIMING,
): Promise<T> {
  const lockPath = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + timing.waitMs
  const token = `${process.pid}.${randomUUID()}`

  while (!tryAcquire(lockPath, token)) {
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath)
    reclaimIfStale(lockPath, timing.staleMs)
    await Bun.sleep(LOCK_POLL_MS)
  }

  try {
    return await critical()
  } finally {
    // Reclaimed as stale while we held it, the path may now be someone else's.
    removeLockIf(lockPath, token)
  }
}

function readCurrent(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Compare-and-swap on a whole JSON file: the value is renamed into place only if
 * `accept` approves what is on disk at that instant (null when missing or
 * unparseable). The temp file is written before the lock is taken so the lock is
 * held for one read and one rename.
 */
export async function writeJsonIf(
  path: string, value: unknown, accept: (current: unknown) => boolean,
  timing: LockTiming = DEFAULT_LOCK_TIMING,
): Promise<boolean> {
  const tmp = await writeTemp(path, value)
  let written = false
  try {
    written = await withFileLock(path, () => {
      if (!accept(readCurrent(path))) return false
      renameSync(tmp, path)
      return true
    }, timing)
    return written
  } finally {
    if (!written) rmSync(tmp, { force: true })
  }
}
