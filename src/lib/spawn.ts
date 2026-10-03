export interface Bounded {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface BoundedOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs: number
}

/** How long the pipes may stay open after the child exits before reading stops. */
const DRAIN_AFTER_EXIT_MS = 500

function spawnPiped(argv: string[], options: BoundedOptions) {
  // Its own process group, so a timeout can kill the descendants that hold the pipes too.
  return Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe', detached: true })
}

interface Drain {
  done: Promise<void>
  text: () => string
  cancel: () => void
}

function drain(stream: ReadableStream<Uint8Array>): Drain {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const done = (async () => {
    try {
      for (;;) {
        const { done: ended, value } = await reader.read()
        if (ended) break
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } catch {
      // Cancelled after the backstop gave up on it; what was read stands.
    }
  })()
  return { done, text: () => text, cancel: () => { reader.cancel().catch(() => {}) } }
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group is already gone.
  }
}

/**
 * Bun.spawn throws synchronously on a missing binary or cwd. Callers rely on
 * this never throwing, so that degrades to code -1, as `Gh.run` does. A
 * descendant left running after a normal exit is not killed (it may be a server
 * the command meant to start), but it cannot hold the call open either.
 */
export async function runBounded(argv: string[], options: BoundedOptions): Promise<Bounded> {
  let proc: ReturnType<typeof spawnPiped>
  try {
    proc = spawnPiped(argv, options)
  } catch (error) {
    return { code: -1, stdout: '', stderr: String(error), timedOut: false }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(proc.pid)
  }, options.timeoutMs)
  // Drained together: reading one pipe to the end first can deadlock on a full other one.
  const stdout = drain(proc.stdout)
  const stderr = drain(proc.stderr)
  try {
    await Promise.race([
      Promise.all([stdout.done, stderr.done]),
      proc.exited.then(() => Bun.sleep(DRAIN_AFTER_EXIT_MS)),
    ])
    stdout.cancel()
    stderr.cancel()
    return { code: await proc.exited, stdout: stdout.text(), stderr: stderr.text(), timedOut }
  } finally {
    clearTimeout(timer)
  }
}
