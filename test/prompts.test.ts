import { existsSync } from 'node:fs'
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

test('no prompt hardcodes the hpipe binary — it must be rendered', async () => {
  // herdr's manifest cannot put a binary on PATH, so a plugin installed from
  // GitHub has no `hpipe`. A prompt naming it literally is uninvokable there.
  for (const name of ALL) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    const bare = text.replace(/\{\{hpipe\}\}/g, '')
    expect(bare, `${name}.md hardcodes hpipe; use {{hpipe}}`).not.toContain('hpipe')
  }
})

test('the hpipe wrapper resolves the installed plugin rather than a fixed checkout', async () => {
  // A symlink straight to src/cli.ts pins hand-typed commands to one checkout,
  // which then writes its own schema into the ledger the installed supervisor
  // drives. The wrapper asks herdr which copy is installed at call time.
  const wrapper = await Bun.file(join(ROOT, 'bin', 'hpipe')).text()
  expect(wrapper).toContain('herdr plugin list --json')
  expect(wrapper).toContain('plugin_root')
  expect(wrapper).toContain('exec bun run')
})

test('the README does not tell anyone to symlink src/cli.ts directly', async () => {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  expect(readme).not.toContain('ln -s /path/to/herdr-plugin-pipeline/src/cli.ts')
  expect(readme).toContain('bin/hpipe')
})

test('the README presents the CLI as optional, not as setup', async () => {
  // The pipeline needs no local config: agents get a rendered invocation and the
  // common human touchpoints are herdr actions.
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  expect(readme).toContain('There is nothing else to install')
  expect(readme).toContain('Install the hpipe shorthand')
})

test('every action declared in the manifest has a script on disk', async () => {
  const manifest = await Bun.file(join(ROOT, 'herdr-plugin.toml')).text()
  for (const [, path] of manifest.matchAll(/command = \["bun", "run", "(src\/actions\/[^"]+)"\]/g)) {
    expect(existsSync(join(ROOT, path as string)), `${path} is declared but missing`).toBe(true)
  }
})
