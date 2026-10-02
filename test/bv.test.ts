import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadsExportPath, beadsHome } from '../src/lib/beads-project'
import { bvTriage } from '../src/lib/bv'
import { makeFakeBin } from './helpers/fake-bin'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bv-'))
  mkdirSync(beadsHome(dir, 'r-abc123'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('bvTriage runs --robot-triage-by-track on the export and returns its triage', async () => {
  const bin = await makeFakeBin(dir, {
    '--robot-triage-by-track': { source_authority: { claim_safe: false }, triage: { alerts: [] }, usage_hints: [] },
  })
  expect(await bvTriage(dir, 'r-abc123', { bin }))
    .toEqual({ triage: { alerts: [] }, source_authority: { claim_safe: false } })
  expect(readFileSync(join(dir, 'calls.log'), 'utf8').trim())
    .toBe(`--robot-triage-by-track --db ${beadsExportPath(dir, 'r-abc123')}`)
})

test('a failing or silent bv is a failure, not a crash', async () => {
  const failing = await makeFakeBin(dir, { '--robot-triage-by-track': { error: { code: 'x', message: 'no db' } } })
  expect(await bvTriage(dir, 'r-abc123', { bin: failing })).toMatchObject({ reason: 'exit' })

  const silentDir = mkdtempSync(join(dir, 'silent-'))
  const silent = await makeFakeBin(silentDir, { '--robot-triage-by-track': 'not json' })
  expect(await bvTriage(dir, 'r-abc123', { bin: silent })).toEqual({ reason: 'output', error: 'bv printed no triage JSON' })
})

test('a load failure bv reports on stdout is the error', async () => {
  const bin = await makeFakeBin(dir, { '--robot-triage-by-track': '{"actionable":false,"error":"open issues.jsonl: no such file"}' },
    { '--robot-triage-by-track': 1 })
  expect(await bvTriage(dir, 'r-abc123', { bin })).toEqual({ reason: 'exit', error: 'open issues.jsonl: no such file' })
})
