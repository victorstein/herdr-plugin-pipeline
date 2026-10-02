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

function spawnPiped(argv: string[], options: BoundedOptions) {
  return Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' })
}

/**
 * Bun.spawn throws synchronously on a missing binary or cwd. Callers rely on
 * this never throwing, so that degrades to code -1, as `Gh.run` does.
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
    proc.kill('SIGKILL')
  }, options.timeoutMs)
  try {
    // Drained together: reading one pipe to the end first can deadlock on a full other one.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ])
    return { code: await proc.exited, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}
