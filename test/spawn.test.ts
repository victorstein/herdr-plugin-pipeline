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
