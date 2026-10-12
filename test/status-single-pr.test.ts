import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRun, withBatch } from '../src/lib/ledger'
import { actionFor, formatStatus, formatTaskDetail } from '../src/lib/status'
import type { Run, Task } from '../src/lib/types'
import { closeReason } from '../src/supervisor/beads-sync'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

const HP = 'bun run /p/src/cli.ts'
const NOW = 10_000_000

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core', depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle', phase: 'implement', phase_entered_at: NOW - 6 * 60_000,
  escalated_from: null, head_sha_at_entry: null, pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} }, merged_at_ms: null, ...beadTaskFields(),
  passes: {}, decisions: [], decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', ...over,
})

function singlePr(tasks: Task[], repoRoot = '/r'): Run {
  const run = withBatch(newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot, title: 'menu' }), batchFixture())
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  run.tasks = tasks
  return run
}

const landed = (sha: string) => ({ title: 'feat(menu): close', land_sha: sha, at: NOW - 3 * 60_000 })

test('the run header says how it ships, how many landed, who holds the slot and who is next', () => {
  const run = singlePr([
    mkTask({ task_id: 't1', phase: 'done', merged_at_ms: 1, landed: [landed('aaa')] }),
    mkTask({ task_id: 't4', phase: 'sync', land_sha: 'bbb' }),
    mkTask({ task_id: 't5', phase: 'land-queue', land_sha: 'ccc', phase_entered_at: 1 }),
    mkTask({ task_id: 't6', phase: 'land-queue', land_sha: 'ddd', phase_entered_at: 2 }),
    mkTask({ task_id: 't7', phase: 'implement' }),
  ])
  const text = formatStatus([run], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW)
  expect(text).toContain('  ships as one PR: batch/x → main · 1 of 5 landed · landing: t4 (sync) · next: t5, t6')
})

test('a repo with no check is flagged: every landing is unverified', () => {
  const text = formatStatus([singlePr([])], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW)
  expect(text).toContain("⚠ no .claude/pipeline-check in this repo: each landing is checked only by its worker's own test run")
  const root = mkdtempSync(join(tmpdir(), 'status-check-'))
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'pipeline-check'), '#!/bin/sh\n')
  chmodSync(join(root, '.claude', 'pipeline-check'), 0o755)
  const checked = formatStatus([singlePr([], root)], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW)
  expect(checked).not.toContain('no .claude/pipeline-check')
  rmSync(root, { recursive: true, force: true })
})

test('whether a check is declared is read from the batch\'s lineage, a task checkout, not the user\'s working copy', () => {
  const working = mkdtempSync(join(tmpdir(), 'status-working-'))
  const checkout = mkdtempSync(join(tmpdir(), 'status-task-'))
  mkdirSync(join(checkout, '.claude'))
  writeFileSync(join(checkout, '.claude', 'pipeline-check'), '#!/bin/sh\n')
  chmodSync(join(checkout, '.claude', 'pipeline-check'), 0o755)
  const run = singlePr([mkTask({ checkout_path: checkout })], working)
  const text = formatStatus([run], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW)
  expect(text).not.toContain('no .claude/pipeline-check')
  rmSync(working, { recursive: true, force: true })
  rmSync(checkout, { recursive: true, force: true })
})

test('a batch that has not fetched, and a supervisor that cannot drive the run, are both your move', () => {
  const run = singlePr([])
  run.batch!.fetch_error = { reason: 'Could not read from remote repository.', since: NOW - 12 * 60_000 }
  const text = formatStatus([run], { state: 'live', pid: 42 }, 'personal', HP, new Set(), NOW)
  expect(text).toContain('⚠ batch/x has not fetched for 12m (Could not read from remote repository.): landings are not being seen')
  expect(text).toContain('⚠ the running supervisor (pid 42) predates single-PR runs and ignores this run: close its ' +
    "Pipeline supervisor pane and run the plugin's supervisor action")
  expect(formatStatus([run], { state: 'live', pid: 42, schemas: [3, 4] }, 'personal', HP, new Set(), NOW))
    .not.toContain('predates single-PR runs')
})

test('a task waiting to land is nobody\'s move, and says who holds the slot', () => {
  const holder = mkTask({ task_id: 't4', phase: 'sync', land_sha: 'b' })
  const waiting = mkTask({ task_id: 't5', phase: 'land-queue', land_sha: 'c' })
  const run = singlePr([holder, waiting])
  expect(actionFor(run, waiting, HP, NOW)).toBe('nothing for you — waiting to land; t4 holds the landing slot (sync)')
  const alone = singlePr([waiting])
  // Landing is the orchestrator's own push, so "nothing for you" alone read as though the plugin landed it.
  expect(actionFor(alone, waiting, HP, NOW))
    .toBe('nothing for you yet — next to land; your land prompt comes when it reaches merge')
  const paneless = mkTask({ task_id: 't6', phase: 'land-queue', land_sha: 'd', pane_id: null })
  expect(actionFor(singlePr([paneless]), paneless, HP, NOW))
    .toContain('it has no agent, so if batch/x moves past it, it needs one in its worktree to sync')
})

test('the holder names the tasks waiting on it', () => {
  const holder = mkTask({ task_id: 't4', phase: 'sync', land_sha: 'b' })
  const run = singlePr([holder, mkTask({ task_id: 't5', phase: 'land-queue' }), mkTask({ task_id: 't6', phase: 'land-queue' })])
  expect(actionFor(run, holder, HP, NOW))
    .toBe("worker's move: t5, t6 wait on this sync; waiting for batch/x merged into t1-branch, checked and resubmitted")
})

test('landing is the orchestrator\'s move, with the command', () => {
  const task = mkTask({ task_id: 't4', phase: 'merge', land_sha: '9e06c2610000' })
  const run = singlePr([task], "/code/o'b")
  expect(actionFor(run, task, HP, NOW)).toBe(
    "YOUR move: `git -C '/code/o'\\''b' push origin 9e06c2610000:refs/heads/batch/x` — waiting for t1-branch at " +
    '9e06c261 to land on batch/x')
})

test('the ship rows say where the final PR stands, and whose move it is', () => {
  const ship = singlePr([])
  ship.phase = 'ship'
  const shipText = formatStatus([ship], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW)
  expect(shipText).toContain('  · final PR: none seen yet — the supervisor records it on its first tick after ' +
    'GitHub lists it')
  expect(shipText).toContain('YOUR move: check the batch and open its PR (the ship prompt has the commands)')

  const ci = singlePr([])
  ci.phase = 'ship-ci'
  ci.batch!.pr = 301
  ci.batch!.ci = 'pending'
  ci.batch!.ci_head = { sha: '9e06c2610000', seen_at: 0 }
  expect(formatStatus([ci], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW))
    .toContain('  · PR #301 ci:pending (on 9e06c261)')

  const merging = singlePr([])
  merging.phase = 'ship-merge'
  merging.batch!.pr = 301
  merging.batch!.ci = 'pass'
  const mergeText = formatStatus([merging], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW)
  expect(mergeText).toContain('  · PR #301 ci:pass')
  expect(mergeText).toContain('YOUR move: squash-merge PR #301 (the ship-merge prompt has the commands)')
})

test('a finished single-PR run says whether it shipped', () => {
  const shipped = singlePr([mkTask({ phase: 'done', merged_at_ms: 1, landed: [landed('a')] })])
  shipped.phase = 'done'
  shipped.batch!.pr = 301
  shipped.batch!.merged_at_ms = 5
  shipped.batch!.merge_commit = '1a2b3c4d5e6f'
  expect(formatStatus([shipped], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW))
    .toContain('  shipped: PR #301 squash-merged as 1a2b3c4d')

  const aborted = singlePr([
    mkTask({ task_id: 't1', phase: 'done', merged_at_ms: 1, landed: [landed('a')] }),
    mkTask({ task_id: 't2', phase: 'implement' }),
  ])
  aborted.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  aborted.escalated_from = 'execute'
  aborted.phase = 'done'
  expect(formatStatus([aborted], { state: 'live', schemas: [3, 4] }, 'personal', HP, new Set(), NOW))
    .toContain('  not shipped: batch/x holds 1 landed task (t1) that is not on main; its bead is closed')
})

test('show tells a single-PR task\'s submission, reviewed head and landings, and that it has no PR or CI', () => {
  const task = mkTask({
    phase: 'merge', land_sha: '4b1d0e2a99',
    submission: { kind: 'implement', title: 'fix(reader): close', head_sha: '9e06c26100', at: NOW - 12 * 60_000, check: 'passed' },
    landed: [{ title: 'fix(reader): close', land_sha: '1111aaaa22', at: NOW - 3 * 60_000 }],
  })
  const detail = formatTaskDetail(singlePr([task]), task, NOW)
  expect(detail).toContain('pr:         none (single-PR run: lands on batch/x)')
  expect(detail).toContain('submitted:  fix(reader): close (implement, at 9e06c261, 12m ago; check passed)')
  expect(detail).toContain('land sha:   4b1d0e2a (reviewed)')
  expect(detail).toContain('landed:     batch/x at 1111aaaa, 3m ago')
  expect(detail).toContain('ci:         n/a — CI runs once, on the batch PR')
})

test('show calls a land sha whose review was skipped submitted, not reviewed', () => {
  const task = mkTask({
    phase: 'land-queue', land_sha: '4b1d0e2a99',
    review_skip: { at: NOW, skipped: ['pr-review'], added_lines: 8, cleared: ['spec-review'] },
  })
  expect(formatTaskDetail(singlePr([task]), task, NOW)).toContain('land sha:   4b1d0e2a (submitted; pr-review skipped)')
})

test('a landed task\'s bead closes naming the batch, and what ships it', () => {
  const task = mkTask({ phase: 'close', merged_at_ms: 1, merge_commit: '4b1d0e2a99', land_sha: '4b1d0e2a99' })
  expect(closeReason(task, singlePr([task]))).toBe('landed on batch/x (4b1d0e2a); ships with the batch PR into main')
  const perTask = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  expect(closeReason(mkTask({ pr: 7, merge_commit: 'abc' }), perTask)).toBe('merged in PR #7 (abc)')
})

test('a missing sha is named whole, never cut to eight characters of its placeholder', () => {
  const unrecorded = mkTask({ phase: 'merge' })
  expect(closeReason(unrecorded, singlePr([unrecorded]))).toContain('landed on batch/x (unknown commit)')
  expect(actionFor(singlePr([unrecorded]), unrecorded, HP, NOW)).toContain('t1-branch at <no reviewed head> to land')
})
