type Schedule = (run: () => void, ms: number) => void

/** Runs `fn` at most once per `gapMs`; calls inside the gap coalesce into one trailing run at its end. */
export function createThrottle(fn: () => void, gapMs: number, now: () => number = Date.now, schedule: Schedule = (run, ms) => setTimeout(run, ms)): () => void {
  let lastRun = -Infinity
  let pending = false
  const run = () => {
    pending = false
    lastRun = now()
    fn()
  }
  return () => {
    if (pending) return
    const wait = lastRun + gapMs - now()
    if (wait <= 0) return run()
    pending = true
    schedule(run, wait)
  }
}
