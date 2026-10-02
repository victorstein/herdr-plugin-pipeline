import { expect, test } from 'bun:test'
import { runBounded } from '../src/lib/spawn'

test('a finished command returns its code and both streams', async () => {
  const out = await runBounded(['sh', '-c', 'echo out; echo err >&2; exit 3'], { timeoutMs: 5_000 })
  expect(out).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
})

test('a missing binary degrades to code -1 instead of throwing', async () => {
  const out = await runBounded(['/nonexistent/bd-binary'], { timeoutMs: 5_000 })
  expect(out.code).toBe(-1)
  expect(out.timedOut).toBe(false)
})

test('a command that outlives the timeout is killed and says so', async () => {
  const started = Date.now()
  const out = await runBounded(['sleep', '10'], { timeoutMs: 200 })
  expect(out.timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('a timeout kills the descendants that hold the pipes, not just the child', async () => {
  const started = Date.now()
  const out = await runBounded(['sh', '-c', 'echo before; sleep 30 & sleep 30'], { timeoutMs: 200 })
  expect(out.timedOut).toBe(true)
  expect(out.stdout).toBe('before\n')
  expect(Date.now() - started).toBeLessThan(3_000)
})

test('a descendant left holding the pipes after a normal exit does not hold the call open', async () => {
  const started = Date.now()
  const out = await runBounded(['sh', '-c', 'echo done; sleep 3 & exit 0'], { timeoutMs: 10_000 })
  expect(out).toEqual({ code: 0, stdout: 'done\n', stderr: '', timedOut: false })
  expect(Date.now() - started).toBeLessThan(2_500)
})
