import { existsSync, statSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDecision } from '../src/lib/decisions'
import { newRun } from '../src/lib/ledger'
import { TASK_ROWS, TIERS } from '../src/lib/phases'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import { dispatchSequence } from '../src/lib/unstarted'
import { renderWorkerPrompt } from '../src/lib/worker-prompt'
import { renderRunPhasePrompt } from '../src/supervisor/deliver'
import { announceDecisions, renderTaskPhasePrompt } from '../src/supervisor/tasks'
import { beadTaskFields } from './helpers/bead-fields'

const ROOT = join(import.meta.dir, '..')
const REVIEW_PROMPTS = [
  'spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality', 'branch-review',
]
const ALL = [
  'spec', 'plan', 'dispatch', 'dispatch-registering', 'worker-brief', 'ci-red', 'merge',
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

test('the worker brief inlines the captured brief and ends the PR body with Refs', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text()
  expect(text).toContain('{{agent_file}}')
  expect(text).toContain('{{brief}}')
  expect(text).toContain('Refs {{bead}}')
  expect(text).not.toContain('gh issue')
  // `render()` throws on a placeholder no caller resolves, so an inherited
  // {{task_text}} kills the first dispatch.
  expect(text).not.toContain('{{task_text}}')
})

test('no template reads an issue any more', async () => {
  for (const name of ALL) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    expect(text, name).not.toContain('{{issue}}')
    expect(text, name).not.toContain('gh issue view')
  }
})

test('a rendered worker brief carries the brief captured at registration', async () => {
  const text = await renderBriefFor([briefTask({})], 0)
  expect(text).toContain('# feat/x — hp-1')
  expect(text).toContain('**Relabel the tile**')
  expect(text).toContain('The settings tile says Foo; it should say Bar.')
  expect(text).toContain('The tile reads Bar.')
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

test('the dispatch prompt shows the same agent start line both dispatch paths print — #118', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text()
  const run = { repo_root: '/r' } as Run
  const task = { task_id: 't1', branch: 'feat/x' } as Task
  const base = { commit: 'c0ffee1', ref: 'origin/main', fetchError: null }
  const printed = dispatchSequence(run, task, base, { kind: 'none' }, 'hp')
  const startLine = printed.split('\n').find((line) => line.includes('herdr agent start'))!.trim()
  expect(text).toContain(startLine.replace('<.result.root_pane.pane_id>', '<root_pane_id>'))
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

test('every action and hook declared in the manifest has a script on disk', async () => {
  const manifest = await Bun.file(join(ROOT, 'herdr-plugin.toml')).text()
  for (const [, path] of manifest.matchAll(/command = \["bun", "run", "(src\/(?:actions|hooks)\/[^"]+)"\]/g)) {
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
    awaiting: 'This phase is waiting for a pushed PR for fix/x (hp-1).',
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
    task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
    keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'research', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
    pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
    artifacts: { research: 'a.md', spec: 'b.md', plan: 'c.md', verdicts: {} },
    merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
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

test('a brief with no notes carries no batch-context heading', async () => {
  // Live-run finding N2: the bare heading rendered with nothing after it.
  for (const notes of ['', '   ']) {
    const text = await renderBriefFor([briefTask({ notes })], 0)
    expect(text).not.toContain('Batch context')
    expect(text).not.toMatch(/\n{3,}/)
  }
})

test('a brief re-sent past research, with no notes, carries no batch-context heading either', async () => {
  const text = await renderBriefFor([briefTask({ notes: '', phase: 'implement' })], 0)
  expect(text).not.toContain('Phase 1 — research')
  expect(text).not.toContain('Batch context')
  expect(text).not.toMatch(/\n{3,}/)
})

test('a brief with notes carries them under the batch-context heading', async () => {
  const text = await renderBriefFor([briefTask({ notes: 'land after t1' })], 0)
  expect(text).toContain('Batch context the public issue does not carry: land after t1')
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

test('the dispatch prompt names every header line a dispatching task prints', async () => {
  // Named rather than counted: `issue:` appears only when --title filed one, and
  // a count is how the convention drifted before.
  const text = await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text()
  for (const line of ['task_id:', 'tier:', 'issue:', 'files:', 'bootstrap:', 'base:']) {
    expect(text).toContain(`\`${line}\``)
  }
  expect(text).not.toMatch(/(two|three|four|five) header/)
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

test('pr-review carries the intent checks, then the quality checks, word for word, under one trailer', async () => {
  const read = (name: string) => Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
  const checks = (text: string) => /^Check: [\s\S]*?\n\n/m.exec(text)?.[0] ?? '(no Check: paragraph)'
  const combined = await read('pr-review')
  const intent = checks(await read('pr-review-intent'))
  const quality = checks(await read('pr-review-quality'))

  expect(combined).toContain(`### Intent\n\n${intent}`)
  expect(combined).toContain(`### Quality\n\n${quality}`)
  expect(combined.indexOf('### Intent')).toBeLessThan(combined.indexOf('### Quality'))
  expect(combined.split('VERDICT: CLEAR')).toHaveLength(2)
})

async function renderPhase(
  phase: TaskPhase, over: Partial<Task> = {}, cameFrom: TaskPhase = phase,
): Promise<string> {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  const task = briefTask({ phase, pr: 7, ...over })
  run.tasks = [task]
  return renderTaskPhasePrompt(run, task, { pluginRoot: ROOT, ciDetail: async () => '- build (fail)' }, cameFrom)
}

test('every task reviewer brief opens its review with the task\'s tier', async () => {
  for (const phase of ['spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality'] as const) {
    expect(await renderPhase(phase, { tier: 'light' }), phase)
      .toContain('Open the review with the line `Tier: light`.')
  }
})

test('the branch review opens with every task\'s tier', async () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'branch-review'
  run.tasks = [
    briefTask({ task_id: 't1', phase: 'done', tier: 'light' }),
    briefTask({ task_id: 't2', phase: 'done' }),
  ]
  expect(await renderRunPhasePrompt(run, ROOT)).toContain('Open the review with the line `Tiers: t1 light, t2 heavy`.')
})

test('no review prompt pins a model: every reviewer inherits the worker\'s', async () => {
  for (const name of REVIEW_PROMPTS) {
    expect(await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text(), name).not.toContain('model:')
  }
})

test('both reviews that judge the plan are told when no plan review ran', async () => {
  for (const phase of ['pr-review', 'pr-review-intent'] as const) {
    expect(await renderPhase(phase, { tier: 'light' }), phase)
      .toContain('the PR does not explain. No plan review ran; judge the plan\'s soundness from the diff as well.')
    expect(await renderPhase(phase, { tier: 'standard', verdict_seq: { 'plan-review': 1 } }), phase)
      .not.toContain('No plan review ran')
  }
})

test('a light task raised to heavy after skipping plan-review is told its plan went unreviewed', async () => {
  expect(await renderPhase('pr-review-intent', { tier: 'heavy', verdict_seq: { 'spec-review': 1 } }))
    .toContain('No plan review ran')
})

function implementersBrief(text: string): string {
  const start = text.indexOf("## The implementer's brief")
  if (start === -1) throw new Error("no implementer's brief")
  return text.slice(start)
}

test('implement and ci-red hand the coding to a sonnet subagent carrying one scoping brief', async () => {
  const implement = await renderPhase('implement', { tier: 'standard' }, 'blocked-on-files')
  const ciRed = await renderPhase('implement', { tier: 'standard' }, 'ci')
  expect(ciRed).toContain('# CI is red')
  for (const text of [implement, ciRed]) {
    expect(text).toContain('`model: sonnet`')
    expect(text).toContain('wait for it within this turn')
    expect(text).toContain('Read `.claude/agents/core-dev.md` before your first edit')
  }
  expect(implementersBrief(ciRed)).toBe(implementersBrief(implement))
})

test('the implementer commits but never pushes, re-reads before editing, and returns questions', async () => {
  const brief = implementersBrief(await Bun.file(join(ROOT, 'prompts', 'implement.md')).text())
  expect(brief).toContain('Re-read every file you are about to touch before you edit it.')
  expect(brief).toContain('Commit, but do not push')
  expect(brief).toContain('return the question')
  expect(brief).toContain('Never commit to or push the default branch.')
})

test('ci-red addresses the worker it is delivered to', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'ci-red.md')).text()
  expect(text).not.toContain('Send the worker back')
  expect(text).toContain('gh run view --log-failed')
})

test('implement calls the plan reviewed only when a plan review ran', async () => {
  const reviewed = await renderPhase('implement', { tier: 'standard', verdict_seq: { 'plan-review': 1 } })
  expect(reviewed).toContain('The plan at `/r/c.md` cleared review.')
  for (const unreviewed of [
    await renderPhase('implement', { tier: 'light' }),
    await renderPhase('implement', { tier: 'standard' }),
  ]) {
    expect(unreviewed).toContain('was not reviewed — read it critically, and fix it first if it is wrong.')
    expect(unreviewed).not.toContain('cleared review')
  }
})

test('an answer that resumes implement keeps the coding with a fresh subagent', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'answer.md')).text()
  expect(prose(text)).toContain('dispatch a fresh one with this answer in its brief')
})

test('the brief lists only the phases its tier runs, with the paths written in', async () => {
  const light = await renderBriefFor([briefTask({ tier: 'light' })], 0)
  expect(light).toContain('1. `research` → `a.md`')
  expect(light).toContain('4. `plan` → `c.md`')
  expect(light).toContain('6. `pr-review` — one review of the PR, intent then quality')
  expect(light).not.toContain('`plan-review`')

  const heavy = await renderBriefFor([briefTask({ tier: 'heavy' })], 0)
  expect(heavy).toContain('5. `plan-review` — you dispatch the reviewer again')
  expect(heavy).toContain('8. `pr-review-quality`')
  expect(heavy).not.toContain('`pr-review` —')
})

test('the brief names the tier, forbids lowering it, and says how to raise it', async () => {
  const text = await renderBriefFor([briefTask({ tier: 'standard' })], 0)
  expect(text).toContain('Your review tier is `standard`: it decides which of those reviews run. Never lower it.')
  expect(text).toMatch(/ tier --task t1 <higher> --why "<what you found>"/)
  const raw = await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text()
  expect(raw).toContain('{{phase_loop}}')
  expect(raw).not.toContain('Between `plan-review` and `implement`')
})

test('research tells the worker to raise a tier that is too low before the spec is written', async () => {
  const text = await renderPhase('research', { tier: 'light' })
  expect(text).toContain('Your review tier is `light`.')
  expect(text).toMatch(/ tier --task t1 <standard\|heavy> --why "<what you found>"/)
})

test('the decision prompt tells the orchestrator to raise the tier when an answer grows the task', async () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  const task = briefTask({ phase: 'blocked-on-decision', decision_from: 'plan', tier: 'light', pane_id: 'w7:p1' })
  openDecision(task, { question: 'q', recommendation: 'r' })
  run.tasks = [task]
  const sent: string[] = []
  await announceDecisions(run, {
    pluginRoot: ROOT, promptRetryMax: 5,
    send: async (_pane, text) => { sent.push(text); return { ok: true } },
    checkSubmission: async () => ({ state: 'submitted' }),
  })
  expect(sent[0]).toContain('`t1` runs the `light` review tier.')
  expect(sent[0]).toMatch(/ tier --task t1 <standard\|heavy> --why "<what the answer adds>"/)
  expect(sent[0]).toContain('Never lower a tier.')
})

test('merge counts the review stages that actually ran', async () => {
  expect(await renderPhase('merge', { tier: 'heavy', verdict_seq: { 'pr-review-intent': 1, 'pr-review-quality': 1 } }))
    .toContain('Both review stages cleared and CI is green on PR #7.')
  expect(await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 } }))
    .toContain('Review cleared and CI is green on PR #7.')
})

test('intake explains the tiers and registers with --tier', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'intake.md')).text()
  expect(text).toContain('[--tier light|standard|heavy]')
  expect(text).toContain('When unsure, pick the higher tier: under-review is the costly mistake.')
  expect(text).toContain('`pipeline:tier-<name>`')
  expect(text).toContain('Never lower a tier')
  expect(text).toContain('then a `tier:` line')
})

test('every prompt renders for every tier on every path with no placeholder left', async () => {
  for (const tier of TIERS) {
    const rendered: Array<[string, string]> = []

    for (const row of TASK_ROWS.filter((r) => r.prompt !== undefined)) {
      rendered.push([row.phase, await renderPhase(row.phase, { tier, escalated_from: 'implement' })])
    }
    rendered.push(['implement from blocked-on-files', await renderPhase('implement', { tier }, 'blocked-on-files')])
    rendered.push(['implement from ci', await renderPhase('implement', { tier }, 'ci')])

    const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
    run.orchestrator_pane = 'w1:p1'
    const task = briefTask({ tier })
    run.tasks = [task]
    rendered.push(['brief and research', await renderWorkerPrompt(ROOT, run, task)])

    const asking = briefTask({ phase: 'blocked-on-decision', decision_from: 'implement', tier, pane_id: 'w7:p1' })
    openDecision(asking, { question: 'q', recommendation: 'r' })
    run.tasks = [asking]
    const sent: string[] = []
    await announceDecisions(run, {
      pluginRoot: ROOT, promptRetryMax: 5,
      send: async (_pane, text) => { sent.push(text); return { ok: true } },
      checkSubmission: async () => ({ state: 'submitted' }),
    })
    rendered.push(['decision', sent[0] ?? '(not sent)'])

    run.phase = 'branch-review'
    run.tasks = [briefTask({ task_id: 't1', phase: 'done', tier })]
    rendered.push(['branch-review', await renderRunPhasePrompt(run, ROOT)])

    for (const [what, text] of rendered) expect(text, `${tier}: ${what}`).not.toContain('{{')
  }
})

test('the README documents tiers, their labels, hpipe tier, the model split and the restart', async () => {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  for (const needle of [
    '## Review tiers', '--tier light|standard|heavy', 'pipeline:tier-light', 'hpipe tier --task',
    'Run Claude with Opus as the default model', 'Restart the supervisor after upgrading',
    'skips the final `branch-review`',
  ]) {
    expect(readme, needle).toContain(needle)
  }
})

test('the skill teaches tiers, hpipe tier, the model requirement and the restart', async () => {
  const skill = await Bun.file(join(ROOT, 'skills', 'herdr-pipeline', 'SKILL.md')).text()
  for (const needle of [
    'hpipe tier --task', 'pipeline:tier-<name>', '--tier light|standard|heavy',
    'Run Claude with Opus as the default model', 'Restart the supervisor after upgrading',
  ]) {
    expect(skill, needle).toContain(needle)
  }
})

function prose(text: string): string {
  return text.replace(/\s+/g, ' ')
}

test('a returned question ends the turn without pushing the subagent\'s unverified work', async () => {
  for (const text of [
    await renderPhase('implement', { tier: 'standard' }, 'blocked-on-files'),
    await renderPhase('implement', { tier: 'standard' }, 'ci'),
  ]) {
    expect(prose(text)).toContain('as your brief describes, and end your turn without pushing')
    expect(prose(text)).toContain('Push only work you have verified')
  }
  expect(prose(await renderBriefFor([briefTask({})], 0))).toContain('unless you are ending it on a decision')
})

test('failed verification goes back to a fresh subagent, never to the worker\'s own hands', async () => {
  for (const text of [
    await renderPhase('implement', { tier: 'standard' }, 'blocked-on-files'),
    await renderPhase('implement', { tier: 'standard' }, 'ci'),
  ]) {
    expect(prose(text)).toContain('If either is red, dispatch a fresh subagent with the failing output')
    expect(prose(text)).toContain('do not fix it yourself')
  }
})

test('the implementer writes conventional-commit messages', async () => {
  const brief = implementersBrief(await renderPhase('implement', { tier: 'standard' }, 'blocked-on-files'))
  expect(prose(brief)).toContain('with a conventional-commit message')
})

test('an answer that resumes implement points at whichever prompt the worker received', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'answer.md')).text()
  expect(prose(text)).toContain('as the implement or CI-red prompt you received describes')
})

test('ci-red re-runs an environmental failure with an empty commit, since only the PR head is watched', async () => {
  const text = prose(await renderPhase('implement', { tier: 'standard' }, 'ci'))
  expect(text).toContain('git commit --allow-empty -m "ci: re-run <check>"')
  expect(text).toContain('say so in the PR')
  expect(text).not.toContain('re-run the check instead of editing code')
})
