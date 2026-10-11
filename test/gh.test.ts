import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const run = (name: string, status: string, conclusion: string) => ({
  __typename: 'CheckRun', name, status, conclusion, workflowName: 'CI (build)',
})

test('headCi reads the head commit\'s own checks and names the head — #16', async () => {
  const bin = await makeFakeBin(dir, {
    'pr view': { headRefOid: 'abc123', statusCheckRollup: [run('lint-title', 'COMPLETED', 'SUCCESS')] },
    'run list': [{ status: 'completed', conclusion: 'success' }],
  })
  expect(await new Gh(bin, dir).headCi(5)).toEqual({ bucket: 'pass', headSha: 'abc123' })
})

test('a workflow run still queued for the head holds CI pending, with no check of its own yet — #16', async () => {
  const bin = await makeFakeBin(dir, {
    'pr view': { headRefOid: 'abc123', statusCheckRollup: [run('lint-title', 'COMPLETED', 'SUCCESS')] },
    'run list': [{ status: 'queued', conclusion: '' }],
  })
  expect((await new Gh(bin, dir).headCi(5))?.bucket).toBe('pending')
  expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toContain('run list --commit abc123 ')
})

test('the head\'s checks bucket the way gh pr checks does', async () => {
  const bucketOf = async (rows: unknown[]) => {
    const bin = await makeFakeBin(dir, { 'pr view': { headRefOid: 'abc', statusCheckRollup: rows }, 'run list': [] })
    return (await new Gh(bin, dir).headCi(5))?.bucket
  }
  expect(await bucketOf([run('build', 'IN_PROGRESS', '')])).toBe('pending')
  expect(await bucketOf([run('build', 'COMPLETED', 'FAILURE')])).toBe('fail')
  expect(await bucketOf([run('build', 'COMPLETED', 'CANCELLED')])).toBe('fail')
  expect(await bucketOf([run('build', 'COMPLETED', 'SKIPPED'), run('test', 'COMPLETED', 'NEUTRAL')])).toBe('pass')
  expect(await bucketOf([{ __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' }])).toBe('pending')
  expect(await bucketOf([{ __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' }])).toBe('fail')
  expect(await bucketOf([])).toBe('pending')
})

test('a gh failure on either call is no reading at all, never a verdict', async () => {
  const noView = await makeFakeBin(dir, { 'pr view': { message: 'gh auth required' } }, { 'pr view': 1 })
  expect(await new Gh(noView, dir).headCi(5)).toBeNull()
  const noRuns = await makeFakeBin(dir, {
    'pr view': { headRefOid: 'abc', statusCheckRollup: [] }, 'run list': { message: 'rate limited' },
  }, { 'run list': 1 })
  expect(await new Gh(noRuns, dir).headCi(5)).toBeNull()
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

test('prForBranch returns the first PR number or null', async () => {
  const bin = await makeFakeBin(dir, { 'pr list': [{ number: 412 }] })
  expect(await new Gh(bin, dir).prForBranch('feat/x')).toBe(412)
})
