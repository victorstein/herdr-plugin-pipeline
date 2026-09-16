import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const REVIEW_PROMPTS = [
  'spec-review', 'plan-review', 'pr-review-intent', 'pr-review-quality', 'branch-review',
]
const ALL = [
  'spec', 'plan', 'dispatch', 'worker-brief', 'ci-red', 'merge', 'close',
  'escalate', 'stall-probe', 'digest', ...REVIEW_PROMPTS,
  'intake', 'decision', 'answer', 'research', 'implement',
]

test('every declared prompt file exists', () => {
  const present = readdirSync(join(ROOT, 'prompts')).map((f) => f.replace(/\.md$/, ''))
  for (const name of ALL) expect(present).toContain(name)
})

test('no orphan prompt files', () => {
  const present = readdirSync(join(ROOT, 'prompts')).map((f) => f.replace(/\.md$/, ''))
  for (const name of present) expect(ALL).toContain(name)
})

test('review prompts demand the trailer as the last line', async () => {
  for (const name of REVIEW_PROMPTS) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    expect(text).toContain('VERDICT: CLEAR')
    expect(text).toContain('VERDICT: BLOCKER')
    expect(text).toContain('last non-empty line')
    expect(text).toContain('{{verdict_path}}')
  }
})

test('the worker brief routes to the surface agent and demands a closing keyword', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text()
  expect(text).toContain('{{agent_file}}')
  expect(text).toContain('Closes #{{issue}}')
  // The issue body is the brief now; `render()` throws on a placeholder no
  // caller resolves, so an inherited {{task_text}} kills the first dispatch.
  expect(text).not.toContain('{{task_text}}')
})

test('every review prompt forbids padding as well as softening', async () => {
  for (const name of REVIEW_PROMPTS) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    expect(text).toContain('Rank honestly')
    expect(text).toContain('a manufactured finding costs as much as a missed one')
  }
})

test('no review prompt still demands a finding', async () => {
  for (const name of REVIEW_PROMPTS) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    expect(text).not.toContain('finds nothing is a failed review')
  }
})

test('the dispatch prompt pins the worktree to the run repo, not the focused workspace', async () => {
  // Live-run finding: without --cwd, herdr resolves the repo from the focused
  // workspace — the supervisor's own on a cold start — and the worker is
  // launched in the wrong repository entirely.
  const text = await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text()
  expect(text).toContain('worktree create --cwd {{repo_root}}')
})
