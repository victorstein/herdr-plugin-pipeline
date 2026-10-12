import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRun, withBatch } from '../src/lib/ledger'
import type { BatchPr } from '../src/lib/machine'
import type { Landing, Run, Task } from '../src/lib/types'
import { evaluateRun, renderRunPhasePrompt, taskOutcomesFor } from '../src/supervisor/deliver'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'
import type { Config } from '../src/lib/config'

const ROOT = join(import.meta.dir, '..')
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ship-prompts-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const landing = (title: string, land_sha: string, at: number): Landing => ({ title, land_sha, at })

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core', depends_on: [], files: [], keep_worktree: false,
  workspace_id: null, pane_id: null, agent_status: 'unknown', phase: 'done', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: 0,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} }, merged_at_ms: 1, ...beadTaskFields(),
  passes: {}, decisions: [], decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', ...over,
})

function shipping(phase: Run['phase'], batchOver: Parameters<typeof batchFixture>[0] = {}): Run {
  const run = withBatch(newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/code/repo', title: 'Reader menu' }),
    batchFixture({ checkout: join(dir, 'checkouts', 'r1'), ...batchOver }))
  run.run_id = 'r1'
  run.phase = phase
  run.tasks = [
    mkTask({ task_id: 't1', bead: 'hp-1', landed: [landing("fix(reader): don't re-render the menu", 'aaa', 1)] }),
    mkTask({ task_id: 't2', bead: 'hp-2', branch: 't2-branch', landed: [landing('feat(reader): add bookmarks', 'bbb', 2)] }),
  ]
  return run
}

test('ship writes the PR body beside the run and renders the commands to check and open the PR', async () => {
  const run = shipping('ship')
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir })
  const body = join(dir, 'runs', 'personal', 'r1.batch-pr.md')
  expect(readFileSync(body, 'utf8')).toContain('BEGIN_COMMIT_OVERRIDE\nfix(reader): don\'t re-render the menu\nfeat(reader): add bookmarks\nEND_COMMIT_OVERRIDE')
  expect(text).toContain("git -C '/code/repo' worktree add --track -B batch/x")
  expect(text).toContain('batch-check')
  expect(text).toContain(`gh pr create --base main --head batch/x --title 'feat: reader menu' --body-file '${body}'`)
  expect(text).not.toContain('{{')
})

test('ship repeats the ruleset advice start gave once, for the batch\'s own pattern', async () => {
  // Printed once, above the intake prompt, it was missed. Measured on a live run.
  const text = (await renderRunPhasePrompt(shipping('ship'), ROOT, { stateDir: dir })).replace(/\s+/g, ' ')
  expect(text).toContain('If `batch/*` has no ruleset blocking force-pushes and deletion, recommend one to the user')
  const own = (await renderRunPhasePrompt(shipping('ship', { branch: 'release/menu' }), ROOT, { stateDir: dir }))
    .replace(/\s+/g, ' ')
  expect(own).toContain('If `release/menu` has no ruleset')
})

test('ship fetches the default branch before asking whether the batch still merges into it', async () => {
  const text = await renderRunPhasePrompt(shipping('ship'), ROOT, { stateDir: dir })
  const checkout = join(dir, 'checkouts', 'r1')
  expect(text).toContain(`git -C '${checkout}' fetch origin +refs/heads/main:refs/remotes/origin/main && ` +
    `git -C '${checkout}' merge-tree --write-tree origin/main origin/batch/x`)
})

test('an odd batch branch reaches gh pr create, and the conflict check, as one word', async () => {
  const run = shipping('ship', { branch: "batch/it's $(id)" })
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir })
  const command = text.split('\n').find((line) => line.trim().startsWith('gh pr create'))!.trim()
  const words = Bun.spawnSync(['sh', '-c', `gh() { printf '%s\\n' "$@"; }; ${command}`], { stdout: 'pipe' })
    .stdout.toString().split('\n')
  expect(words.slice(words.indexOf('--head') + 1)[0]).toBe("batch/it's $(id)")
  expect(text).toContain("merge-tree --write-tree origin/main 'origin/batch/it'\\''s $(id)'")
})

test('ship with a PR already open updates its body instead, and once the checkout exists only pulls it', async () => {
  const run = shipping('ship', { pr: 301 })
  mkdirSync(run.batch!.checkout, { recursive: true })
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir })
  expect(text).toContain(`gh pr edit 301 --body-file '${join(dir, 'runs', 'personal', 'r1.batch-pr.md')}'`)
  expect(text).toContain(`git -C '${run.batch!.checkout}' pull --ff-only`)
  expect(text).not.toContain('worktree add')
})

test('re-entered from a red ship-ci, ship carries the failing checks and the three routes', async () => {
  const run = shipping('ship', { pr: 301 })
  run.passes['ship-ci'] = 1
  run.history.push({ at: 1, from: 'ship-ci', to: 'ship', why: 'CI failed' })
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir, ciDetail: async (pr) => `- build (fail) for #${pr}` })
  expect(text).toContain('# CI is red on the batch PR — run r1, PR #301')
  expect(text).toContain('- build (fail) for #301')
  expect(text).toContain('A small defect — the default')
  expect(text.replace(/\s+/g, ' ')).toContain('a second red escalates the run')
  expect(text).not.toContain('{{')
})

test('the red-CI patch route brings the checkout up to date the way ship does, bootstrap included', async () => {
  const run = shipping('ship', { pr: 301 })
  run.repo_root = join(dir, 'repo')
  mkdirSync(join(run.repo_root, '.claude'), { recursive: true })
  writeFileSync(join(run.repo_root, '.claude', 'pipeline-bootstrap'), '#!/bin/sh\nbun install\n')
  chmodSync(join(run.repo_root, '.claude', 'pipeline-bootstrap'), 0o755)
  mkdirSync(run.batch!.checkout, { recursive: true })
  run.passes['ship-ci'] = 1
  run.history.push({ at: 1, from: 'ship-ci', to: 'ship', why: 'CI failed' })
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir, ciDetail: async () => '- build (fail)' })
  const checkout = run.batch!.checkout
  expect(text).toContain(`       git -C '${checkout}' pull --ff-only\n` +
    `       (cd '${checkout}' && ./.claude/pipeline-bootstrap)  # if the pull changed what it builds\n`)
  expect(text).not.toContain('{{')
})

test('ship-merge renders both commands with every title shell-quoted, and writes the squash body', async () => {
  const run = shipping('ship-merge', { pr: 301 })
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir })
  const squash = join(dir, 'runs', 'personal', 'r1.squash-body.md')
  expect(text).toContain(`gh pr merge 301 --squash --subject 'fix(reader): don'\\''t re-render the menu' --body-file '${squash}'`)
  expect(readFileSync(squash, 'utf8')).toBe('feat(reader): add bookmarks\n')
  expect(existsSync(join(dir, 'runs', 'personal', 'r1.batch-pr.md'))).toBe(true)
  expect(text).not.toContain('{{')
})

test('ship-merge calls CI green only when a pass is recorded, and otherwise has CI checked first', async () => {
  // Smoke run 14: a rewind into ship-merge said "CI is green on PR #53" with no CI result recorded.
  const green = await renderRunPhasePrompt(shipping('ship-merge', { pr: 301, ci: 'pass' }), ROOT, { stateDir: dir })
  expect(green).toContain('CI is green on PR #301, `batch/x` into `main`. Merge it with exactly these two commands:')
  expect(green).not.toContain('gh pr checks')

  for (const ci of [null, 'pending', 'fail'] as const) {
    const text = await renderRunPhasePrompt(shipping('ship-merge', { pr: 301, ci }), ROOT, { stateDir: dir })
    expect(text, String(ci)).not.toContain('CI is green')
    expect(text, String(ci)).toContain('No green CI is recorded on PR #301, `batch/x` into `main`. Check it first, ' +
      'and merge only once every check passes:\n\n    gh pr checks 301\n\nMerge it with exactly these two commands:')
  }
})

test('ship-merge warns that the body edit replaces the description, and that a 5xx is rerun', async () => {
  const text = (await renderRunPhasePrompt(shipping('ship-merge', { pr: 301 }), ROOT, { stateDir: dir }))
    .replace(/\s+/g, ' ')
  expect(text).toContain("replaces PR #301's whole description")
  expect(text).toContain(`add it to \`${join(dir, 'runs', 'personal', 'r1.batch-pr.md')}\` first, outside the override block`)
  expect(text).toContain("A 5xx from `gh` is GitHub's, not yours:** run the same command again.")
})

test('the branch review of a single-PR run reads the batch diff and speaks of landings', async () => {
  const run = shipping('branch-review')
  run.tasks.push(mkTask({ task_id: 't3', phase: 'failed', merged_at_ms: null }))
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir })
  expect(text).toContain('git diff origin/main...origin/batch/x')
  expect(text).toContain('Not every task in **Reader menu** landed on `batch/x`')
  expect(text).toContain('`t3` (hp-1, `t1-branch`) stopped at `failed` — its work never landed on `batch/x`')
  expect(text).toContain('Review what is on the batch branch.')
  expect(text).toContain('you patch `batch/x` directly')
  expect(text).not.toContain('{{')
})

test('a task that landed and was then abandoned is on the batch, and the outcome says so', () => {
  const run = shipping('branch-review')
  run.tasks = [mkTask({ phase: 'failed', merged_at_ms: null, landed: [landing('feat: x', 'aaa', 1)] })]
  expect(taskOutcomesFor(run)).toContain('stopped at `failed` — it landed on `batch/x` before it stopped')
  const all = shipping('branch-review')
  expect(taskOutcomesFor(all)).toBe('Every task in **Reader menu** has landed on `batch/x` and is torn down.')
})

const CONFIG = { MAX_PASSES: 2, FILE_SETTLE_MS: 0 } as Config

function ghFake(pr: BatchPr | null, found: number | null = pr?.number ?? null) {
  const asked: string[] = []
  return {
    asked,
    gh: {
      prForBranch: async (branch: string) => { asked.push(`list ${branch}`); return found },
      prView: async (n: number) => {
        asked.push(`view ${n}`)
        return pr === null ? null : { merged: pr.merged, mergedAtMs: pr.mergedAtMs, mergeCommit: pr.mergeCommit, headSha: pr.headSha }
      },
      prChecksDetail: async () => '',
    },
  }
}

test('ship finds the batch PR by its branch, and clears on a checked head', async () => {
  const run = shipping('ship', { checked: { head_sha: 'h1', at: 1, check: 'passed' } })
  run.orchestrator_pane = 'w1:p1'
  const { gh, asked } = ghFake({ number: 301, headSha: 'h1', merged: false, mergedAtMs: null, mergeCommit: null })
  const result = await evaluateRun(run, gh, CONFIG, async () => true)
  expect(asked).toEqual(['list batch/x', 'view 301'])
  expect(result.advanced).toBe(true)
  expect(run.phase).toBe('ship-ci')
})

test('ship-merge records the squash merge and ends the run with a done notice that names it', async () => {
  const run = shipping('ship-merge', { pr: 301, ci_head: { sha: 'h1', seen_at: 0 } })
  run.orchestrator_pane = 'w1:p1'
  const { gh } = ghFake({ number: 301, headSha: 'h1', merged: true, mergedAtMs: 9, mergeCommit: '1a2b3c4d5e' })
  const result = await evaluateRun(run, gh, CONFIG, async () => true)
  expect(run.phase).toBe('done')
  expect(result.nextPrompt).toContain('shipped: PR #301 squash-merged as 1a2b3c4d')
})
