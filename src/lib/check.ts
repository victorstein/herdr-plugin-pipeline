import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Printed verbatim into prompts as well as resolved on disk, like `BOOTSTRAP_REL`. */
export const CHECK_REL = '.claude/pipeline-check'

export type Check = { kind: 'none' } | { kind: 'ready' } | { kind: 'not-executable' }

/**
 * Whether a repo declares the check a single-PR landing is re-tested with. With
 * no per-task CI it is the only test a landed tree gets before the final PR.
 * Pure filesystem and never throws, like `repoBootstrap`.
 */
export function repoCheck(root: string): Check {
  try {
    const info = statSync(join(root, CHECK_REL))
    if (!info.isFile()) return { kind: 'none' }
    return (info.mode & 0o111) === 0 ? { kind: 'not-executable' } : { kind: 'ready' }
  } catch {
    return { kind: 'none' }
  }
}

export function checkLine(check: Check): string {
  if (check.kind === 'none') {
    return "check: none — each landing is checked only by its worker's own test run, and status says so"
  }
  if (check.kind === 'not-executable') {
    return `check: ${CHECK_REL} (NOT EXECUTABLE — chmod +x it on the default branch, or every submit refuses)`
  }
  return `check: ${CHECK_REL}`
}

export interface CheckRun { code: number; tail: string; timedOutAfterMs?: number }

const TAIL_LINES = 40

/**
 * Inside the 10-minute Bash timeout `submit` and `batch-check` run under, with room
 * for their network calls. Killed by that timeout, the CLI dies with nothing said
 * and leaves the check's own children running.
 */
export const CHECK_DEADLINE_MS = 9 * 60_000

const spoken = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`)

export interface LoggedRunOptions {
  deadlineMs: number
  /** How the script's process group is stopped at the deadline; SIGKILL at once unless the caller grants a grace. */
  stop?: (pgid: number) => Promise<void>
  /** Hears the script's pid, which is also its process group. */
  onStart?: (pgid: number) => void
}

async function killGroupNow(pgid: number): Promise<void> {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/**
 * Runs the repo's `rel` script in `checkout`, writing everything it prints to
 * `logPath`. Never in the supervisor's tick, which is serial: a test suite or a
 * bootstrap takes minutes. Its own process group, so a deadline stops whatever
 * the script started too.
 */
export async function runLogged(
  checkout: string, rel: string, logPath: string, options: LoggedRunOptions,
): Promise<CheckRun> {
  mkdirSync(dirname(logPath), { recursive: true })
  const log = openSync(logPath, 'w')
  const deadline: { hit: boolean; stopped: Promise<void> } = { hit: false, stopped: Promise.resolve() }
  let code: number
  try {
    const proc = Bun.spawn([join(checkout, rel)], {
      cwd: checkout, stdin: 'ignore', stdout: log, stderr: log, detached: true,
    })
    options.onStart?.(proc.pid)
    const timer = setTimeout(() => {
      deadline.hit = true
      deadline.stopped = (options.stop ?? killGroupNow)(proc.pid)
    }, options.deadlineMs)
    try {
      code = await proc.exited
    } finally {
      clearTimeout(timer)
    }
    await deadline.stopped
  } catch (error) {
    writeFileSync(logPath, `${rel} could not be run: ${String(error)}\n`)
    code = -1
  } finally {
    closeSync(log)
  }
  if (deadline.hit) appendFileSync(logPath, `\n${rel} was stopped after ${spoken(options.deadlineMs)}\n`)
  const lines = readFileSync(logPath, 'utf8').replace(/\n+$/, '').split('\n')
  const tail = lines.slice(-TAIL_LINES).join('\n')
  return deadline.hit ? { code, tail, timedOutAfterMs: options.deadlineMs } : { code, tail }
}

export function runCheck(checkout: string, logPath: string, deadlineMs = CHECK_DEADLINE_MS): Promise<CheckRun> {
  return runLogged(checkout, CHECK_REL, logPath, { deadlineMs })
}

/** How a refusal names a check that did not pass. */
export function checkFailure(ran: CheckRun): string {
  return ran.timedOutAfterMs === undefined
    ? `failed (exit ${ran.code})`
    : `did not finish within ${spoken(ran.timedOutAfterMs)} and was stopped, with everything it started`
}
