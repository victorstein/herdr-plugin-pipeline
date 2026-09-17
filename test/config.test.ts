import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/lib/config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cfg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('returns defaults when no config file exists', async () => {
  const cfg = await loadConfig(dir)
  expect(cfg.TICK_MS).toBe(1000)
  expect(cfg.MAX_PASSES).toBe(2)
  expect(cfg.WAKE_ON).toEqual(['blocked', 'done', 'idle', 'unknown', 'exited', 'released'])
  expect(cfg.REPOS_ALLOW).toEqual([])
})

test('overrides numbers and lists from config.env', async () => {
  await Bun.write(join(dir, 'config.env'), [
    '# a comment',
    'TICK_MS=250',
    'WAKE_ON=blocked,done',
    'REPOS_ALLOW=repo-a,repo-b',
    '',
  ].join('\n'))
  const cfg = await loadConfig(dir)
  expect(cfg.TICK_MS).toBe(250)
  expect(cfg.WAKE_ON).toEqual(['blocked', 'done'])
  expect(cfg.REPOS_ALLOW).toEqual(['repo-a', 'repo-b'])
})

test('ignores a non-numeric override and keeps the default', async () => {
  await Bun.write(join(dir, 'config.env'), 'TICK_MS=banana\n')
  expect((await loadConfig(dir)).TICK_MS).toBe(1000)
})

test('parses HPIPE_LINK as a boolean', async () => {
  await Bun.write(join(dir, 'config.env'), 'HPIPE_LINK=0\n')
  expect((await loadConfig(dir)).HPIPE_LINK).toBe(false)
})

test('parses HPIPE_LINK=false as false', async () => {
  await Bun.write(join(dir, 'config.env'), 'HPIPE_LINK=false\n')
  expect((await loadConfig(dir)).HPIPE_LINK).toBe(false)
})

test('STALL_PROBE_MAX defaults to 3 and parses from config.env', async () => {
  expect((await loadConfig(dir)).STALL_PROBE_MAX).toBe(3)
  await Bun.write(join(dir, 'config.env'), 'STALL_PROBE_MAX=5\n')
  expect((await loadConfig(dir)).STALL_PROBE_MAX).toBe(5)
})
