import { expect, test } from 'bun:test'
import {
  batchPrBody, checkoutSteps, defaultBatchBranch, fetchBatchCommand, landCommand, mergeBatchCommand,
  releaseLines, squashBody, squashSubject, suggestedPrTitle,
} from '../src/lib/batch'
import { newRun, withBatch } from '../src/lib/ledger'
import type { Landing, Run, Task } from '../src/lib/types'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'done', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

const landing = (title: string, land_sha: string, at: number): Landing => ({ title, land_sha, at })

function runOf(tasks: Partial<Task>[]): Run {
  const run = withBatch(newRun({
    session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: "/code/o'brien", title: 'Reader menu fixes',
  }), batchFixture({ checkout: '/state/checkouts/r1' }))
  run.run_id = 'r1'
  run.tasks = tasks.map(mkTask)
  return run
}

test('the default batch branch is batch/ and the run id without its repo prefix', () => {
  expect(defaultBatchBranch('berean-os-20261011-reader-menu-ab12', '/code/berean-os'))
    .toBe('batch/20261011-reader-menu-ab12')
})

test('every command that touches the batch names it by an explicit refspec, and quotes the repo', () => {
  const run = runOf([])
  expect(fetchBatchCommand(run.batch!)).toBe('git fetch origin +refs/heads/batch/x:refs/remotes/origin/batch/x')
  expect(mergeBatchCommand(run.batch!))
    .toBe('git fetch origin +refs/heads/batch/x:refs/remotes/origin/batch/x && git merge --no-edit origin/batch/x')
  expect(landCommand(run, '9e06c2610000')).toBe("git -C '/code/o'\\''brien' push origin 9e06c2610000:refs/heads/batch/x")
})

test('the batch checkout is created once at its absolute path, and only pulled after that', () => {
  const run = runOf([])
  expect(checkoutSteps(run, false)).toEqual([
    "git -C '/code/o'\\''brien' fetch origin +refs/heads/batch/x:refs/remotes/origin/batch/x",
    "git -C '/code/o'\\''brien' worktree add --track -B batch/x '/state/checkouts/r1' origin/batch/x",
  ])
  expect(checkoutSteps(run, true)).toEqual(["git -C '/state/checkouts/r1' pull --ff-only"])
})

test('release lines are every landing in landing order, a re-landing of one sha once', () => {
  const run = runOf([
    { task_id: 't1', landed: [landing('feat(reader): add bookmarks', 'aaa', 1), landing('fix(reader): keep bookmarks', 'ccc', 3)] },
    { task_id: 't2', landed: [landing('fix(menu): close on escape', 'bbb', 2), landing('fix(menu): close on escape', 'bbb', 4)] },
    { task_id: 't3', phase: 'failed' },
  ])
  expect(releaseLines(run).map((l) => l.title)).toEqual([
    'feat(reader): add bookmarks', 'fix(menu): close on escape', 'fix(reader): keep bookmarks',
  ])
})

test('a task landed twice under one title contributes it once', () => {
  const run = runOf([
    { task_id: 't1', landed: [landing('fix(menu): close on escape', 'aaa', 1), landing('fix(menu): close on escape', 'bbb', 2)] },
  ])
  expect(releaseLines(run).map((l) => l.title)).toEqual(['fix(menu): close on escape'])
})

test('the PR body carries one override line per landing, and names what is not in it', () => {
  const run = runOf([
    { task_id: 't1', bead: 'berean-o-1', landed: [landing('fix(reader): close the menu', 'aaa', 1)] },
    { task_id: 't2', bead: 'berean-o-2', landed: [landing('feat(reader): add bookmarks', 'bbb', 2)] },
    { task_id: 't5', bead: 'berean-o-5', phase: 'failed' },
  ])
  expect(batchPrBody(run)).toBe([
    'Reader menu fixes: one PR for run r1',
    '',
    '| Task | Bead | Change |',
    '|---|---|---|',
    '| t1 | berean-o-1 | fix(reader): close the menu |',
    '| t2 | berean-o-2 | feat(reader): add bookmarks |',
    '',
    'Not in this PR: t5 (berean-o-5) stopped at failed.',
    '',
    'Refs berean-o-1, berean-o-2',
    '',
    'BEGIN_COMMIT_OVERRIDE',
    'fix(reader): close the menu',
    'feat(reader): add bookmarks',
    'END_COMMIT_OVERRIDE',
    '',
  ].join('\n'))
})

test('a task rewound and abandoned after it landed keeps its line, because its commits are on the batch', () => {
  const run = runOf([{ task_id: 't1', phase: 'failed', landed: [landing('feat(x): y', 'aaa', 1)] }])
  expect(batchPrBody(run)).toContain('BEGIN_COMMIT_OVERRIDE\nfeat(x): y\nEND_COMMIT_OVERRIDE')
  expect(batchPrBody(run)).not.toContain('Not in this PR')
})

test('the squash commit carries every line: the first as its subject, the rest in its body', () => {
  const run = runOf([
    { task_id: 't1', landed: [landing('fix(reader): close the menu', 'aaa', 1)] },
    { task_id: 't2', landed: [landing("feat(reader)!: don't keep bookmarks", 'bbb', 2)] },
    { task_id: 't3', landed: [landing('perf(db): batch the reads', 'ccc', 3)] },
  ])
  expect(squashSubject(run)).toBe('fix(reader): close the menu')
  expect(squashBody(run)).toBe("feat(reader)!: don't keep bookmarks\nperf(db): batch the reads\n")
})

test('the suggested PR title takes the strongest type, a breaking mark, and the run title', () => {
  const run = runOf([
    { task_id: 't1', landed: [landing('fix(reader): close the menu', 'aaa', 1)] },
    { task_id: 't2', landed: [landing('feat(reader)!: add bookmarks', 'bbb', 2)] },
  ])
  expect(suggestedPrTitle(run)).toBe('feat!: reader menu fixes')
  const fixes = runOf([{ task_id: 't1', landed: [landing('refactor: a', 'a', 1), landing('fix: b', 'b', 2)] }])
  expect(suggestedPrTitle(fixes)).toBe('fix: reader menu fixes')
  const chores = runOf([{ task_id: 't1', landed: [landing('chore: a', 'a', 1)] }])
  expect(suggestedPrTitle(chores)).toBe('chore: reader menu fixes')
})
