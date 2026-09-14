import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drain, enqueue, gcStaleTmp, queueName } from '../src/lib/queue'
import type { QueuedEvent } from '../src/lib/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'queue-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ev = (n: number): QueuedEvent => ({
  kind: 'pane.agent_status_changed', session: 'default', at: n, pane_id: `p${n}`,
})

test('names sort lexicographically into emission order within a process', () => {
  const names = [queueName(1, 0, 9), queueName(1, 1, 88888), queueName(1, 2, 9)]
  expect([...names].sort()).toEqual(names)
})

test('names are unique across calls with identical (atMs, sequence, pid), as with a reused pid', () => {
  const names = new Set(Array.from({ length: 1000 }, () => queueName(1, 0, 9)))
  expect(names.size).toBe(1000)
})

test('N concurrent enqueues all drain to exactly N events, none overwritten', async () => {
  const n = 20
  await Promise.all(Array.from({ length: n }, (_, i) => enqueue(dir, ev(i))))
  const drained = await drain(dir)
  expect(drained).toHaveLength(n)
})

test('drain returns events in emission order', async () => {
  for (let i = 0; i < 8; i++) await enqueue(dir, ev(i))
  const drained = await drain(dir)
  expect(drained.map((e) => e.at)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
})

test('drain removes the files it processed', async () => {
  await enqueue(dir, ev(1))
  await drain(dir)
  expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
})

test('drain ignores a partially written .tmp file', async () => {
  await enqueue(dir, ev(1))
  await Bun.write(join(dir, '0000000001-000000-000001.json.tmp'), '{"half')
  const drained = await drain(dir)
  expect(drained).toHaveLength(1)
})

test('drain skips an unparseable event without losing the rest', async () => {
  await enqueue(dir, ev(1))
  await Bun.write(join(dir, '9999999999-000000-000001.json'), 'not json')
  await enqueue(dir, ev(2))
  expect((await drain(dir)).map((e) => e.at)).toEqual([1, 2])
})

test('gcStaleTmp removes only .tmp files older than the cutoff', async () => {
  const fresh = join(dir, 'a.json.tmp')
  await Bun.write(fresh, 'x')
  await Bun.write(join(dir, 'keep.json'), '{}')
  expect(await gcStaleTmp(dir, 0)).toBe(1)
  expect(readdirSync(dir)).toEqual(['keep.json'])
})
