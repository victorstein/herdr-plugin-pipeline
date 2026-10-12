import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetDispatchBases } from '../src/lib/dispatch-base'
import { BATCH_SCHEMA_VERSION, listRuns } from '../src/lib/ledger'
import type { SupervisorPid } from '../src/lib/types'
import { cmdStart, startBatch, startBeads } from './helpers/cmd-start'
import { cleanupFixtures, cloneOfRemote, commitAs, git, landOnRemote, revParse } from './helpers/git-worktree'

let dir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'start-single-pr-')) })
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  forgetDispatchBases()
  cleanupFixtures()
})

const input = (repoRoot: string, over: { batchBranch?: string | null; title?: string } = {}) => ({
  title: over.title ?? 'reader menu', repoKey: repoRoot, repoRoot, socketPath: '/s', paneId: 'w1:p1',
  workspaceId: 'w1', singlePr: true, batchBranch: over.batchBranch ?? null,
})

const remoteHead = (remote: string, branch: string): string =>
  Bun.spawnSync(['git', '-C', remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    .stdout.toString().trim()

const savedRuns = () => listRuns(dir, 'personal')

const supervisorPid = (schemas?: number[]): SupervisorPid => ({
  pid: 77, pane_pid: 1, started_at_ms: 1, session: 'personal', socket_path: '/s', pane_id: 'w1:p9',
  ...(schemas === undefined ? {} : { schemas }),
})

test('start --single-pr pushes a batch branch at the default branch as just fetched, and records it', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const fresh = landOnRemote(remote, 'main')

  const out = await cmdStart(ctx(), input(clone, { batchBranch: 'batch/menu' }))
  expect(out.ok).toBe(true)
  expect(remoteHead(remote, 'batch/menu')).toBe(fresh)
  expect(out.text).toContain(
    `batch: batch/menu at ${fresh.slice(0, 8)} (origin/main as just fetched) — this run ships as one PR into main`)
  expect(out.text).toContain("check: none — each landing is checked only by its worker's own test run")
  expect(out.text).toContain('**This run ships as one PR.**')

  const [run] = await savedRuns()
  expect(run?.schema_version).toBe(BATCH_SCHEMA_VERSION)
  expect(run?.batch).toEqual({
    branch: 'batch/menu', into: 'main', base_commit: fresh, checkout: join(dir, 'checkouts', run!.run_id),
    pr: null, head_sha_at_entry: null, ci: null, merged_at_ms: null, merge_commit: null,
  })
})

test('the batch branch defaults to batch/ and the run id without its repo prefix', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const out = await cmdStart(ctx(), input(clone))
  expect(out.ok).toBe(true)
  const [run] = await savedRuns()
  const repoName = clone.split('/').pop()!
  expect(run?.batch?.branch).toBe(`batch/${run!.run_id.slice(repoName.length + 1)}`)
  expect(remoteHead(remote, run!.batch!.branch)).toBe(revParse(clone, 'origin/main'))
})

test('a declared check is named, and the ruleset that makes the gate server-side is recommended', async () => {
  const { clone } = cloneOfRemote('main')
  mkdirSync(join(clone, '.claude'), { recursive: true })
  writeFileSync(join(clone, '.claude', 'pipeline-check'), '#!/bin/sh\ntrue\n')
  chmodSync(join(clone, '.claude', 'pipeline-check'), 0o755)
  const out = await cmdStart(ctx(), input(clone, { batchBranch: 'batch/menu' }))
  expect(out.text).toContain('check: .claude/pipeline-check\n')
  expect(out.text).toContain('ruleset: ')
  expect(out.text).toContain('batch/*')
})

test('a retry after a start whose save failed adopts the branch it already pushed', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const head = revParse(clone, 'origin/main')
  git(['push', '-q', 'origin', `${head}:refs/heads/batch/menu`], clone)
  const out = await cmdStart(ctx(), input(clone, { batchBranch: 'batch/menu' }))
  expect(out.ok).toBe(true)
  expect(out.text).toContain('already on origin at that commit, so it is adopted')
  expect(remoteHead(remote, 'batch/menu')).toBe(head)
})

test('a batch branch that exists at another commit is refused, and nothing is saved', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const elsewhere = landOnRemote(remote, 'batch/menu')
  const out = await cmdStart(ctx(), input(clone, { batchBranch: 'batch/menu' }))
  expect(out.ok).toBe(false)
  expect(out.text).toContain(`batch/menu already exists on origin at ${elsewhere.slice(0, 8)}`)
  expect(await savedRuns()).toEqual([])
})

test('the default branch, or a name git would refuse, is not a batch branch', async () => {
  const { clone } = cloneOfRemote('main')
  for (const name of ['main', 'batch..menu']) {
    const out = await cmdStart(ctx(), input(clone, { batchBranch: name }))
    expect(out.ok, name).toBe(false)
  }
  expect((await cmdStart(ctx(), input(clone, { batchBranch: 'main' }))).text).toContain('is the default branch')
  expect(await savedRuns()).toEqual([])
})

test('a push that fails saves no run', async () => {
  const { remote, clone } = cloneOfRemote('main')
  writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "branch rule: no batch/*" >&2\nexit 1\n')
  chmodSync(join(remote, 'hooks', 'pre-receive'), 0o755)
  const out = await cmdStart(ctx(), input(clone, { batchBranch: 'batch/menu' }))
  expect(out.ok).toBe(false)
  expect(out.text).toContain('could not push batch/menu')
  expect(await savedRuns()).toEqual([])
})

test('a Beads setup that fails leaves no branch behind', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const out = await cmdStart(ctx(), input(clone, { batchBranch: 'batch/menu' }), startBeads({
    setup: async () => ({ ok: false, error: 'no store' }),
  }))
  expect(out.ok).toBe(false)
  expect(remoteHead(remote, 'batch/menu')).toBe('')
})

test('a fetch that fails refuses the start: a stale base would put shipped work in the batch PR', async () => {
  const { clone } = cloneOfRemote('main')
  git(['remote', 'set-url', 'origin', join(tmpdir(), 'hpipe-missing-remote.git')], clone)
  const out = await cmdStart(ctx(), input(clone))
  expect(out.ok).toBe(false)
  expect(out.text).toContain('could not fetch the default branch')
  expect(await savedRuns()).toEqual([])
})

test('a repo with no origin cannot ship a batch PR', async () => {
  const { clone } = cloneOfRemote('main')
  git(['remote', 'remove', 'origin'], clone)
  const out = await cmdStart(ctx(), input(clone))
  expect(out.ok).toBe(false)
  expect(out.text).toContain('origin')
})

test('start refuses beside a live supervisor that predates single-PR runs, naming the restart', async () => {
  const { remote, clone } = cloneOfRemote('main')
  const old = startBatch({ supervisor: async () => ({ state: 'live', info: supervisorPid() }) })
  const out = await cmdStart(ctx(), input(clone, { batchBranch: 'batch/menu' }), startBeads(), old)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('the supervisor of session personal (pid 77) predates single-PR runs')
  expect(out.text).toContain('Pipeline supervisor')
  expect(remoteHead(remote, 'batch/menu')).toBe('')
  expect(await savedRuns()).toEqual([])
})

test('start goes ahead beside a current supervisor, a stale one or none', async () => {
  for (const state of [
    { state: 'live' as const, info: supervisorPid([3, 4]) },
    { state: 'stale' as const, info: supervisorPid() },
    { state: 'none' as const },
  ]) {
    const { clone } = cloneOfRemote('main')
    const out = await cmdStart(ctx(), input(clone, { batchBranch: 'batch/menu' }), startBeads(),
      startBatch({ supervisor: async () => state }))
    expect(out.ok, state.state).toBe(true)
  }
})

test('a repo that does not allow squash merges is refused, and so is one gh cannot read', async () => {
  const { clone } = cloneOfRemote('main')
  const off = await cmdStart(ctx(), input(clone), startBeads(),
    startBatch({ squashMergeAllowed: async () => ({ allowed: false }) }))
  expect(off.ok).toBe(false)
  expect(off.text).toContain('does not allow squash merges')
  const broken = await cmdStart(ctx(), input(clone), startBeads(),
    startBatch({ squashMergeAllowed: async () => ({ error: 'gh auth login' }) }))
  expect(broken.ok).toBe(false)
  expect(broken.text).toContain('gh auth login')
  expect(await savedRuns()).toEqual([])
})

test('--batch-branch alone is refused: a per-task run has no batch', async () => {
  const { clone } = cloneOfRemote('main')
  const out = await cmdStart(ctx(), { ...input(clone, { batchBranch: 'batch/menu' }), singlePr: false })
  expect(out.ok).toBe(false)
  expect(out.text).toContain('--batch-branch only goes with --single-pr')
})

test('a per-task start touches no git and prints no batch line', async () => {
  const { remote, clone } = cloneOfRemote('main')
  commitAs(clone, 'x.txt', 'x')
  const out = await cmdStart(ctx(), { ...input(clone), singlePr: false })
  expect(out.ok).toBe(true)
  expect(out.text).not.toContain('batch:')
  expect(out.text).not.toContain('ships as one PR')
  expect((await savedRuns())[0]?.batch).toBeUndefined()
  expect(remoteHead(remote, 'batch/menu')).toBe('')
})
