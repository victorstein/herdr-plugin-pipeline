import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync,
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

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    throw error
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
  // Two waiters can both judge the same lock stale; the inode check keeps the
  // slower one from unlinking the lock the faster one has just taken. It narrows
  // that race rather than closing it — at worst one write goes unguarded, which
  // is what every write was before this lock existed.
  try {
    if (statSync(lockPath).ino === seen.ino) unlinkSync(lockPath)
  } catch {
    // Already gone: someone else reclaimed or released it.
  }
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

  while (!tryAcquire(lockPath)) {
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath)
    reclaimIfStale(lockPath, timing.staleMs)
    await Bun.sleep(LOCK_POLL_MS)
  }

  try {
    return await critical()
  } finally {
    try {
      unlinkSync(lockPath)
    } catch {
      // Reclaimed as stale while we held it; nothing of ours left to remove.
    }
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
