import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LockTimeoutError, readJson, withFileLock, writeJson, writeJsonIf } from '../src/lib/store'

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

test('writeJsonIf writes only when the predicate accepts what is on disk', async () => {
  const p = join(dir, 'a.json')
  await writeJson(p, { rev: 1 })
  const revIs = (n: number) => (current: unknown) => (current as { rev: number }).rev === n

  expect(await writeJsonIf(p, { rev: 2 }, revIs(0))).toBe(false)
  expect(await readJson<{ rev: number }>(p)).toEqual({ rev: 1 })
  expect(await writeJsonIf(p, { rev: 2 }, revIs(1))).toBe(true)
  expect(await readJson<{ rev: number }>(p)).toEqual({ rev: 2 })
  expect(readdirSync(dir).filter((f) => f !== 'a.json')).toHaveLength(0)
})

test('a lock left behind by a dead holder is reclaimed once it is stale', async () => {
  const p = join(dir, 'a.json')
  writeFileSync(`${p}.lock`, '99999')
  const past = new Date(Date.now() - 60_000)
  utimesSync(`${p}.lock`, past, past)

  expect(await withFileLock(p, () => 'got it', { staleMs: 1_000, waitMs: 500 })).toBe('got it')
  expect(existsSync(`${p}.lock`)).toBe(false)
})

test('a fresh lock held by someone else times out instead of blocking forever', async () => {
  const p = join(dir, 'a.json')
  writeFileSync(`${p}.lock`, String(process.pid))

  const started = Date.now()
  await expect(withFileLock(p, () => 'never', { staleMs: 60_000, waitMs: 100 }))
    .rejects.toBeInstanceOf(LockTimeoutError)
  expect(Date.now() - started).toBeLessThan(1_000)
  expect(existsSync(`${p}.lock`)).toBe(true)
})

test('the lock is released when the critical section throws', async () => {
  const p = join(dir, 'a.json')
  await expect(withFileLock(p, () => { throw new Error('boom') })).rejects.toThrow('boom')
  expect(existsSync(`${p}.lock`)).toBe(false)
})
