import { expect, test } from 'bun:test'
import { createThrottle } from '../../src/kit/throttle'

function harness(gapMs: number) {
  let clock = 0
  let runs = 0
  const timers: { at: number; run: () => void }[] = []
  const throttled = createThrottle(() => runs++, gapMs, () => clock, (run, ms) => timers.push({ at: clock + ms, run }))
  const advance = (to: number) => {
    clock = to
    for (const t of timers.splice(0).filter((t) => t.at <= to)) t.run()
  }
  return { throttled, advance, runs: () => runs, timers }
}

test('the first call runs at once', () => {
  const h = harness(400)
  h.throttled()
  expect(h.runs()).toBe(1)
  expect(h.timers).toHaveLength(0)
})

test('calls inside the gap coalesce into one run at the end of the gap', () => {
  const h = harness(400)
  h.throttled()
  h.advance(100)
  h.throttled()
  h.throttled()
  expect(h.runs()).toBe(1)
  expect(h.timers.map((t) => t.at)).toEqual([400])
  h.advance(400)
  expect(h.runs()).toBe(2)
})

test('the gap is measured from the trailing run', () => {
  const h = harness(400)
  h.throttled()
  h.advance(100)
  h.throttled()
  h.advance(400)
  h.throttled()
  expect(h.runs()).toBe(2)
  expect(h.timers.map((t) => t.at)).toEqual([800])
})

test('a call after the gap runs at once', () => {
  const h = harness(400)
  h.throttled()
  h.advance(500)
  h.throttled()
  expect(h.runs()).toBe(2)
})
