import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { newRun, withBatch } from '../src/lib/ledger'
import type { BatchPr } from '../src/lib/machine'
import type { Landing, Run, Task } from '../src/lib/types'
import { CI_SETTLE_MS, ciTransitions } from '../src/supervisor/ci'
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

test('ship names the repo\'s check before the batch checkout it asks for exists', async () => {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'pipeline-check'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(repo, '.claude', 'pipeline-check'), 0o755)
  const run = shipping('ship')
  run.repo_root = repo
  const text = (await renderRunPhasePrompt(run, ROOT, { stateDir: dir })).replace(/\s+/g, ' ')
  expect(text).toContain(`runs \`.claude/pipeline-check\` in \`${run.batch!.checkout}\` at that head`)
  expect(text).not.toContain('declares no')
})

test('ship repeats the ruleset advice start gave once, for the batch\'s own pattern', async () => {
  // Printed once, above the intake prompt, it was missed. Measured on a live run.
  const text = (await renderRunPhasePrompt(shipping('ship'), ROOT, { stateDir: dir })).replace(/\s+/g, ' ')
  expect(text).toContain('If `batch/*` has no ruleset blocking force-pushes and deletion, recommend one to the user')
  const own = (await renderRunPhasePrompt(shipping('ship', { branch: 'release/menu' }), ROOT, { stateDir: dir }))
    .replace(/\s+/g, ' ')
  expect(own).toContain('If `release/menu` has no ruleset')
})

test('ship gives no ruleset advice when start found a ruleset protecting the batch', async () => {
  const run = shipping('ship', { ruleset_protected: true })
  const text = (await renderRunPhasePrompt(run, ROOT, { stateDir: dir })).replace(/\s+/g, ' ')
  expect(text).toContain("Never force-push, rebase or squash `batch/x`: its history is every landing's record.")
  expect(text).not.toContain('ruleset')
  expect(text).not.toContain('{{')
})

// Smoke run 15: the orchestrator added a line to the PR on GitHub during `ship`, which
// the merge step's `gh pr edit --body-file` would have dropped.
test('ship warns that the merge step replaces the PR body, so additions go into the body file just before it', async () => {
  const text = (await renderRunPhasePrompt(shipping('ship'), ROOT, { stateDir: dir })).replace(/\s+/g, ' ')
  const body = join(dir, 'runs', 'personal', 'r1.batch-pr.md')
  expect(text).toContain(`The merge step replaces the PR's whole description with \`${body}\`, so anything you add ` +
    'to the PR on GitHub is dropped. Something worth keeping goes into that file instead, outside the override ' +
    'block, and only just before the merge: the plugin rewrites it with every ship prompt.')
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
  const run = shipping('ship', { pr: 301, ci: 'fail' })
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
  const run = shipping('ship', { pr: 301, ci: 'fail' })
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

test('ship-merge and the red-CI empty commit both say a push is checked again before CI', async () => {
  const merge = (await renderRunPhasePrompt(shipping('ship-merge', { pr: 301 }), ROOT, { stateDir: dir }))
    .replace(/\s+/g, ' ')
  expect(merge).toContain('If anything is pushed to `batch/x` now, the run goes back to `ship`, to run')
  expect(merge).not.toContain('back to `ship-ci`')
  const run = shipping('ship', { pr: 301, ci: 'fail' })
  run.history.push({ at: 1, from: 'ship-ci', to: 'ship', why: 'CI failed' })
  const red = (await renderRunPhasePrompt(run, ROOT, { stateDir: dir })).replace(/\s+/g, ' ')
  expect(red).toContain('Push an empty commit to `batch/x` from its checkout, then run')
  expect(red).toContain('this phase clears only on a new head that `batch-check` recorded')
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

test('ship-merge pins the head CI passed on, and names it', async () => {
  // The trial's ship-merge command carried no head guard although the skill says merges do: between a push
  // and the supervisor's next fetch it would merge a head CI never ran on. Measured on a live run.
  const sha = '2da97b97' + '4'.repeat(32)
  const pinned = await renderRunPhasePrompt(shipping('ship-merge', { pr: 301, ci: 'pass', ci_head: { sha, seen_at: 1 } }),
    ROOT, { stateDir: dir })
  expect(pinned).toContain(`\n    gh pr merge 301 --squash --match-head-commit ${sha} --subject `)
  expect(pinned.replace(/\s+/g, ' ')).toContain('**Green is for `2da97b97`, the head CI ran on.** The merge command ' +
    'merges only while the PR\'s head is still that commit. If anything is pushed to `batch/x` now')

  for (const over of [{ ci: 'pass' as const }, { ci: 'fail' as const, ci_head: { sha, seen_at: 1 } }]) {
    const text = await renderRunPhasePrompt(shipping('ship-merge', { pr: 301, ...over }), ROOT, { stateDir: dir })
    expect(text).toContain('\n    gh pr merge 301 --squash --subject ')
    expect(text).not.toContain('--match-head-commit')
    expect(text.replace(/\s+/g, ' ')).toContain('**Green is for the head CI ran on.** If anything is pushed')
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

test('ship never waits on the orchestrator\'s background work: a poller waiting for ship-ci would hold it', async () => {
  const run = shipping('ship', { checked: { head_sha: 'h1', at: 1, check: 'passed' } })
  run.orchestrator_pane = 'w1:p1'
  const { gh } = ghFake({ number: 301, headSha: 'h1', merged: false, mergedAtMs: null, mergeCommit: null })
  let asked = 0
  const result = await evaluateRun(run, gh, CONFIG, async () => true, {}, async () => { asked += 1; return { hold: true } })
  expect(result.advanced).toBe(true)
  expect(run.phase).toBe('ship-ci')
  expect(asked).toBe(0)
})

test('a branch review waits for the subagent still writing it, then past the cap goes ahead and says so', async () => {
  const run = shipping('branch-review')
  run.orchestrator_pane = 'w1:p1'
  run.repo_root = dir
  run.phase_entered_at = Date.now() - 60_000
  const review = join(dir, 'docs', 'superpowers', 'reviews', `${run.run_id}-branch-review-0.md`)
  mkdirSync(dirname(review), { recursive: true })
  writeFileSync(review, 'Fine.\n\nVERDICT: CLEAR\n')
  const { gh } = ghFake(null)

  expect((await evaluateRun(run, gh, CONFIG, async () => true, { stateDir: dir }, async () => ({ hold: true })))
    .advanced).toBe(false)
  expect(run.phase).toBe('branch-review')

  const past = await evaluateRun(run, gh, CONFIG, async () => true, { stateDir: dir },
    async () => ({ hold: false, past: ['general-purpose subagent'] }))
  expect(past.advanced).toBe(true)
  expect(run.history.at(-1)?.why).toBe('review cleared; advanced past background work still running ' +
    '(general-purpose subagent) after 10m')
})

test('a head pushed past the checked one sends ship-merge back to ship, whose prompt has the batch checked again', async () => {
  const run = shipping('ship-merge', {
    pr: 301, ci: 'pass', ci_head: { sha: 'd6e5c6e0', seen_at: 0 }, checked: { head_sha: 'd6e5c6e0', at: 1, check: 'passed' },
  })
  run.orchestrator_pane = 'w1:p1'
  const { gh } = ghFake({ number: 301, headSha: 'd63fe8e0', merged: false, mergedAtMs: null, mergeCommit: null })
  const result = await evaluateRun(run, gh, CONFIG, async () => true, { stateDir: dir })
  expect(run.phase).toBe('ship')
  expect(run.history.at(-1)?.why).toBe('head moved to d63fe8e0 past d6e5c6e0, the head batch-check recorded')
  expect(result.nextPrompt).toContain('# Ship — run r1')
  expect(result.nextPrompt).toContain('batch-check')
  expect(result.nextPrompt).not.toContain('CI is red')
})

test('a head CI was read on past the checked one sends ship-ci back to ship before it can reach the merge', async () => {
  const run = shipping('ship-ci', { pr: 301, checked: { head_sha: 'd6e5c6e0', at: 1, check: 'passed' } })
  run.orchestrator_pane = 'w1:p1'
  await ciTransitions([run], async () => ({ bucket: 'pass', headSha: 'd63fe8e0' }), 0)
  await ciTransitions([run], async () => ({ bucket: 'pass', headSha: 'd63fe8e0' }), CI_SETTLE_MS)
  expect(run.batch?.ci).toBe('pass')
  const { gh, asked } = ghFake(null)
  const result = await evaluateRun(run, gh, CONFIG, async () => true, { stateDir: dir })
  expect(run.phase).toBe('ship')
  expect(asked).toEqual([])
  expect(result.nextPrompt).toContain('# Ship — run r1')
  expect(result.nextPrompt).not.toContain('CI is red')
})

test('ship-merge is GitHub\'s fact: the orchestrator\'s background work does not hold it', async () => {
  const run = shipping('ship-merge', { pr: 301, ci_head: { sha: 'h1', seen_at: 0 } })
  run.orchestrator_pane = 'w1:p1'
  const { gh } = ghFake({ number: 301, headSha: 'h1', merged: true, mergedAtMs: 9, mergeCommit: '1a2b3c4d5e' })
  await evaluateRun(run, gh, CONFIG, async () => true, {}, async () => ({ hold: true }))
  expect(run.phase).toBe('done')
})

test('ship-merge records the squash merge and ends the run with a done notice that names it', async () => {
  const run = shipping('ship-merge', { pr: 301, ci_head: { sha: 'h1', seen_at: 0 } })
  run.orchestrator_pane = 'w1:p1'
  const { gh } = ghFake({ number: 301, headSha: 'h1', merged: true, mergedAtMs: 9, mergeCommit: '1a2b3c4d5e' })
  const result = await evaluateRun(run, gh, CONFIG, async () => true)
  expect(run.phase).toBe('done')
  expect(result.nextPrompt).toContain('shipped: PR #301 squash-merged as 1a2b3c4d')
})
