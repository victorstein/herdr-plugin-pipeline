import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJson, writeJson } from '../src/lib/store'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('round-trips a value', async () => {
  const p = join(dir, 'a.json')
  await writeJson(p, { hello: 'world' })
  expect(await readJson<{ hello: string }>(p)).toEqual({ hello: 'world' })
})

test('returns null for a missing file', async () => {
  expect(await readJson(join(dir, 'nope.json'))).toBeNull()
})

test('returns null for unparseable content rather than throwing', async () => {
  const p = join(dir, 'bad.json')
  await Bun.write(p, '{not json')
  expect(await readJson(p)).toBeNull()
})

test('creates parent directories', async () => {
  const p = join(dir, 'nested', 'deep', 'a.json')
  await writeJson(p, { n: 1 })
  expect(await readJson<{ n: number }>(p)).toEqual({ n: 1 })
})

test('leaves no .tmp file behind', async () => {
  const p = join(dir, 'a.json')
  await writeJson(p, { n: 1 })
  expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
})

test('concurrent writes from the same process both resolve and leave valid JSON', async () => {
  const p = join(dir, 'a.json')
  await Promise.all([writeJson(p, { who: 'a' }), writeJson(p, { who: 'b' })])
  const result = await readJson<{ who: string }>(p)
  expect(result).not.toBeNull()
  expect(['a', 'b']).toContain(result!.who)
})
