import { existsSync, statSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '../src/lib/types'

const ROOT = join(import.meta.dir, '..')
const REVIEW_PROMPTS = [
  'spec-review', 'plan-review', 'pr-review-intent', 'pr-review-quality', 'branch-review',
]
const ALL = [
  'spec', 'plan', 'dispatch', 'worker-brief', 'ci-red', 'merge', 'close',
  'escalate', 'stall-probe', 'stall-escalate', ...REVIEW_PROMPTS,
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

test('both dispatch paths point the orchestrator at the base: line, never a stale local main', async () => {
  // #87: `--base main` cut a dependent task from a local main that predated its
  // merged dependency. Live-run finding.
  const dispatch = await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text()
  expect(dispatch).not.toContain('--base main')
  expect(dispatch).toContain('--base <base>')
  expect(dispatch).toContain('`base:`')
  const intake = await Bun.file(join(ROOT, 'prompts', 'intake.md')).text()
  expect(intake).toContain('`base: <commit> (…)`')
  expect(intake).toContain('--base <commit>')
})

test('the dispatch prompt hands the brief over through hpipe, never as an agent start argument', async () => {
  // herdr rejects a brief as an `agent start` argument (invalid_agent_argument),
  // and the send-text workaround left one sitting unsubmitted. Live-run finding.
  const text = await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text()
  expect(text).toContain('{{hpipe}} dispatch --task <task_id> --pane <root_pane_id>')
  expect(text).not.toContain('"<the worker brief you were given>"')
  expect(text).not.toMatch(/agent start[^\n]*\\\n[^\n]*brief/)
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

test('every hook declared in the manifest has a script on disk, and worktree.opened is one — #94', async () => {
  const manifest = await Bun.file(join(ROOT, 'herdr-plugin.toml')).text()
  for (const [, path] of manifest.matchAll(/command = \["bun", "run", "(src\/hooks\/[^"]+)"\]/g)) {
    expect(existsSync(join(ROOT, path as string)), `${path} is declared but missing`).toBe(true)
  }
  // `herdr worktree open` emits only this, never `worktree.created`, so without it
  // a task whose checkout survived its workspace can never be bound again.
  expect(manifest).toMatch(/on = "worktree\.opened"\ncommand = \["bun", "run", "src\/hooks\/worktree-opened\.ts"\]/)
})

test('the plugin manifest version matches version.txt', async () => {
  // release-please's `simple` type bumps version.txt; the manifest is only kept
  // in step once stein-infra adds extra-files. Until then this catches drift.
  const manifest = await Bun.file(join(ROOT, 'herdr-plugin.toml')).text()
  const declared = /^version = "([^"]+)"/m.exec(manifest)?.[1]
  const canonical = (await Bun.file(join(ROOT, 'version.txt')).text()).trim()
  expect(declared, 'herdr-plugin.toml version is stale against version.txt').toBe(canonical)
})

test('the stall escalation prompt carries its own variables, not escalate.md\'s', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'stall-escalate.md')).text()
  for (const key of ['{{run_id}}', '{{phase}}', '{{minutes}}', '{{probes}}',
                     '{{awaiting_short}}', '{{resume_command}}', '{{undelivered}}', '{{abandon}}']) {
    expect(text, `stall-escalate.md must render ${key}`).toContain(key)
  }
  expect(text).not.toContain('review passes')
  expect(text).not.toContain('{{pass}}')
})

test('the stall probe asserts nothing about the shape of what it is waiting for', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'stall-probe.md')).text()
  expect(text).toContain('{{awaiting}}')
  expect(text).toContain('{{ladder}}')
  // The defect this issue was filed over: the template asserted the value was a
  // filesystem path, which is false for seven of the nine signals.
  expect(text).not.toContain('appeared at')
  expect(text).not.toContain('path above')
  expect(text).not.toContain('{{artifact_path}}')
  expect(text).not.toContain('will not ask again')
})

test('a rendered probe leaves no placeholder behind', async () => {
  const { renderPrompt } = await import('../src/lib/render')
  const text = await renderPrompt(ROOT, 'stall-probe', {
    run_id: 'r1', phase: 'implement', minutes: '45',
    awaiting: 'This phase is waiting for a pushed PR for fix/x (#1).',
    ladder: 'This is probe 1 of 3.',
  })
  expect(text).not.toContain('{{')
})

test('the escalation prompt does not understate what rewind clears', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'escalate.md')).text()
  // `cmdRewind` clears the whole counter map (`src/cli.ts:360`, `:370`), not one phase's.
  expect(text).not.toContain('resets the pass count')
  expect(text).toContain('clears every pass counter')
})

test('the worker brief carries the bootstrap note', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text()
  expect(text).toContain('{{bootstrap_note}}')
})

function briefTask(overrides: Partial<Task>): Task {
  return {
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core', depends_on: [], files: [],
    keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'research', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
    pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
    artifacts: { research: 'a.md', spec: 'b.md', plan: 'c.md', verdicts: {} },
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: 'n',
    ...overrides,
  }
}

async function renderBriefFor(tasks: Task[], index: number): Promise<string> {
  const { renderWorkerPrompt } = await import('../src/lib/worker-prompt')
  const { newRun } = await import('../src/lib/ledger')
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.tasks = tasks
  return renderWorkerPrompt(ROOT, run, run.tasks[index]!)
}

test('a rendered worker brief leaves no placeholder behind', async () => {
  // render() throws on an unresolved {{token}} at DELIVERY time, in front of an
  // agent — modelled on 'a rendered probe leaves no placeholder behind' above.
  const text = await renderBriefFor([briefTask({})], 0)
  expect(text).not.toContain('{{')
})

test('a task depending on a core-surface sibling gets no repo-specific build command', async () => {
  // A plugin-side build line can only be one repo's convention shipped to every
  // other repo; the build belongs in that repo's own bootstrap.
  const text = await renderBriefFor([
    briefTask({ task_id: 't1', surface: 'core' }),
    briefTask({ task_id: 't2', surface: 'web', depends_on: ['t1'] }),
  ], 1)
  expect(text).not.toContain('pnpm')
  expect(text).not.toContain('turbo')
  expect(text).not.toContain('@repo/core')
})

test('the worker brief has no plugin-side build note', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text()
  expect(text).not.toContain('{{dist_note}}')
})

test('the merge prompt asks for a bootstrap re-run where the rebase happens', async () => {
  // The orchestrator is the one told to rebase, so the re-run cue lives here and
  // not in the worker's brief.
  const text = await Bun.file(join(ROOT, 'prompts', 'merge.md')).text()
  expect(text).toContain('rebase')
  expect(text).toContain('.claude/pipeline-bootstrap')
})

test('the dispatch prompt names all four header lines, not three', async () => {
  // A dispatching cmdTask emits task_id:, files:, bootstrap: and base:. A stale
  // count here is how the convention drifts, and nothing else pins it.
  const text = await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text()
  expect(text).toContain('bootstrap:')
  expect(text).toContain('four header')
  expect(text).not.toContain('three header')
})

test('the README documents the per-repo bootstrap contract', async () => {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  expect(readme).toContain('.claude/pipeline-bootstrap')
})

test('this repo declares its own bootstrap, and it is executable', () => {
  // Dogfood: a fresh worktree of this repo has no node_modules, so
  // `bun run typecheck` cannot find tsc until this runs.
  const path = join(ROOT, '.claude', 'pipeline-bootstrap')
  expect(existsSync(path)).toBe(true)
  expect(statSync(path).mode & 0o111).toBeGreaterThan(0)
})
