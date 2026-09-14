import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const REVIEW_PROMPTS = [
  'spec-review', 'plan-review', 'task-review-spec', 'task-review-quality', 'branch-review',
]
const ALL = [
  'spec', 'plan', 'dispatch', 'task', 'ci-red', 'merge', 'close',
  'escalate', 'stall-probe', 'digest', ...REVIEW_PROMPTS,
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

test('the task prompt routes to the surface agent and demands a closing keyword', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'task.md')).text()
  expect(text).toContain('{{agent_file}}')
  expect(text).toContain('Closes #{{issue}}')
})
