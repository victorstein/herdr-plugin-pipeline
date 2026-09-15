import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Gh, rollUpBucket } from '../src/lib/gh'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gh-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('any fail makes the roll-up fail', () => {
  expect(rollUpBucket([{ bucket: 'pass' }, { bucket: 'fail' }, { bucket: 'pending' }])).toBe('fail')
})

test('any pending with no fail makes the roll-up pending', () => {
  expect(rollUpBucket([{ bucket: 'pass' }, { bucket: 'pending' }])).toBe('pending')
})

test('all pass makes the roll-up pass, and skipping does not block it', () => {
  expect(rollUpBucket([{ bucket: 'pass' }, { bucket: 'skipping' }])).toBe('pass')
})

test('an empty check list is pending, never pass', () => {
  expect(rollUpBucket([])).toBe('pending')
})

test('exit code 8 is read as pending rather than an error', async () => {
  const bin = await makeFakeBin(dir, { 'pr checks': [{ bucket: 'pending', name: 'ci' }] }, { 'pr checks': 8 })
  expect(await new Gh(bin, dir).prChecks(5)).toBe('pending')
})

test('a gh failure maps to unknown, which is not terminal', async () => {
  const bin = await makeFakeBin(dir, { 'pr checks': { message: 'gh auth required' } }, { 'pr checks': 1 })
  expect(await new Gh(bin, dir).prChecks(5)).toBe('unknown')
})

test('prView reads merged from state and mergedAt, not a merged field', async () => {
  const bin = await makeFakeBin(dir, {
    'pr view': { state: 'MERGED', mergedAt: '2026-09-13T10:00:00Z', headRefOid: 'abc123' },
  })
  const view = await new Gh(bin, dir).prView(5)
  expect(view).toEqual({ merged: true, mergedAtMs: Date.parse('2026-09-13T10:00:00Z'), headSha: 'abc123' })
})

test('an open PR is not merged and has no mergedAt', async () => {
  const bin = await makeFakeBin(dir, { 'pr view': { state: 'OPEN', mergedAt: null, headRefOid: 'abc' } })
  expect(await new Gh(bin, dir).prView(5)).toMatchObject({ merged: false, mergedAtMs: null })
})

test('issueView reads closed and closedAt', async () => {
  const bin = await makeFakeBin(dir, { 'issue view': { closed: true, closedAt: '2026-09-13T11:00:00Z' } })
  expect(await new Gh(bin, dir).issueView(210))
    .toEqual({ closed: true, closedAtMs: Date.parse('2026-09-13T11:00:00Z') })
})

test('prForBranch returns the first PR number or null', async () => {
  const bin = await makeFakeBin(dir, { 'pr list': [{ number: 412 }] })
  expect(await new Gh(bin, dir).prForBranch('feat/x')).toBe(412)
})
