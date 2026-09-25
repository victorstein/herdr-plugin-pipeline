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
    'pr view': {
      state: 'MERGED', mergedAt: '2026-09-13T10:00:00Z', mergeCommit: { oid: 'm3rg3' }, headRefOid: 'abc123',
    },
  })
  const view = await new Gh(bin, dir).prView(5)
  expect(view).toEqual({
    merged: true, mergedAtMs: Date.parse('2026-09-13T10:00:00Z'), mergeCommit: 'm3rg3', headSha: 'abc123',
  })
})

test('an open PR is not merged and has no mergedAt', async () => {
  const bin = await makeFakeBin(dir, { 'pr view': { state: 'OPEN', mergedAt: null, headRefOid: 'abc' } })
  expect(await new Gh(bin, dir).prView(5)).toMatchObject({ merged: false, mergedAtMs: null, mergeCommit: null })
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

test('issueCreate files with the given title and body file and returns the new number', async () => {
  const bin = await makeFakeBin(dir, { 'issue create': 'https://github.com/o/r/issues/318\n' })
  expect(await new Gh(bin, dir).issueCreate('Relabel the tile', '/tmp/body.md'))
    .toEqual({ number: 318, url: 'https://github.com/o/r/issues/318' })
  expect(await Bun.file(join(dir, 'calls.log')).text())
    .toBe('issue create --title Relabel the tile --body-file /tmp/body.md\n')
})

test('issueCreate passes gh\'s stderr through on failure, and fails on output with no issue URL', async () => {
  const failing = await makeFakeBin(dir, { 'issue create': { error: { message: 'auth' } } })
  expect(await new Gh(failing, dir).issueCreate('t', '/b'))
    .toEqual({ error: JSON.stringify({ error: { message: 'auth' } }) })
  const urlless = await makeFakeBin(dir, { 'issue create': 'Creating issue in o/r\n' })
  expect(await new Gh(urlless, dir).issueCreate('t', '/b')).toMatchObject({ error: expect.any(String) })
})
