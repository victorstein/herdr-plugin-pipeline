import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFresh, parseVerdict } from '../src/lib/predicates'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pred-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function writeAged(name: string, body: string, mtimeMs: number): Promise<string> {
  const p = join(dir, name)
  await Bun.write(p, body)
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
  return p
}

test('a file older than phase entry is not fresh', async () => {
  const p = await writeAged('spec.md', 'x', 1_000)
  expect(await isFresh(p, 5_000)).toBe(false)
})

test('a file newer than phase entry is fresh', async () => {
  const p = await writeAged('spec.md', 'x', 9_000)
  expect(await isFresh(p, 5_000)).toBe(true)
})

test('a missing file is never fresh', async () => {
  expect(await isFresh(join(dir, 'nope.md'), 0)).toBe(false)
})

test('sub-millisecond mtime does not read as fresh against a truncated phase entry', async () => {
  // Date.now() truncates; statSync().mtimeMs does not. A file written a fraction of a
  // millisecond before phase entry must NOT count as fresh.
  const p = await writeAged('spec.md', 'x', 5_000)
  utimesSync(p, new Date(5_000), new Date(5_000))
  const withFraction = join(dir, 'frac.md')
  await Bun.write(withFraction, 'x')
  const entered = Math.floor(statSync(withFraction).mtimeMs)
  expect(await isFresh(withFraction, entered)).toBe(false)
})

test('parses a CLEAR trailer', async () => {
  const p = await writeAged('r.md', 'findings\n\nVERDICT: CLEAR\n', 9_000)
  expect(await parseVerdict(p)).toEqual({ verdict: 'CLEAR', blockers: 0, majors: 0 })
})

test('parses a BLOCKER trailer with counts', async () => {
  const p = await writeAged('r.md', 'x\n\nVERDICT: BLOCKER\nBLOCKERS: 2\nMAJORS: 5\n', 9_000)
  expect(await parseVerdict(p)).toEqual({ verdict: 'BLOCKER', blockers: 2, majors: 5 })
})

test('an indented quotation of the contract is not read as a verdict', async () => {
  // The review prompts document the trailer as an indented block, so a reviewer
  // narrating the contract writes exactly this. Trimming first made it
  // indistinguishable from a real verdict and produced a false CLEAR.
  const p = await writeAged('r.md', [
    '# Review', 'I found 3 BLOCKER issues.', '',
    'Per the contract, the trailer format required is:', '',
    '    VERDICT: CLEAR', '',
  ].join('\n'), 9_000)
  expect(await parseVerdict(p)).toBeNull()
})

test('uses the LAST verdict line when an earlier one stands at column 0', async () => {
  const p = await writeAged(
    'r.md', 'VERDICT: BLOCKER\nBLOCKERS: 1\n\nsuperseded\n\nVERDICT: CLEAR\n', 9_000,
  )
  expect((await parseVerdict(p))?.verdict).toBe('CLEAR')
})

test('rejects CLEAR carrying blocker counts as self-contradictory', async () => {
  const p = await writeAged('r.md', 'x\n\nVERDICT: CLEAR\nBLOCKERS: 3\n', 9_000)
  expect(await parseVerdict(p)).toBeNull()
})

test('accepts CLEAR carrying major counts, which the contract permits', async () => {
  const p = await writeAged('r.md', 'x\n\nVERDICT: CLEAR\nMAJORS: 2\n', 9_000)
  expect(await parseVerdict(p)).toEqual({ verdict: 'CLEAR', blockers: 0, majors: 2 })
})

test('rejects a trailer that is not the last non-empty line', async () => {
  const p = await writeAged('r.md', 'VERDICT: CLEAR\n\nstill writing the next section\n', 9_000)
  expect(await parseVerdict(p)).toBeNull()
})

test('returns null for a file with no trailer', async () => {
  const p = await writeAged('r.md', 'no verdict here\n', 9_000)
  expect(await parseVerdict(p)).toBeNull()
})
