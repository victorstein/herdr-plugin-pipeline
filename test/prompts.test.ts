import { existsSync, statSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDecision } from '../src/lib/decisions'
import { newRun, withBatch } from '../src/lib/ledger'
import { rowRunsIn, type RunMode, TASK_ROWS, taskRow, TIERS } from '../src/lib/phases'
import { hpipeCommand } from '../src/lib/render'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import { dispatchSequence } from '../src/lib/unstarted'
import { renderWorkerPrompt } from '../src/lib/worker-prompt'
import { renderRunPhasePrompt } from '../src/supervisor/deliver'
import { announceDecisions, renderTaskPhasePrompt } from '../src/supervisor/tasks'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'

const ROOT = join(import.meta.dir, '..')
const REVIEW_PROMPTS = [
  'spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality', 'branch-review',
]
const ALL = [
  'spec', 'plan', 'dispatch', 'dispatch-registering', 'worker-brief', 'ci-red', 'merge',
  'escalate', 'stall-probe', 'stall-escalate', ...REVIEW_PROMPTS,
  'intake', 'decision', 'answer', 'research', 'implement', 'usage-resume', 'usage-lifted', 'carry-on',
  'sync', 'merge-batch', 'ship', 'ship-ci-red', 'ship-merge', 'handoff-pr', 'handoff-batch',
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
  expect(text).toContain('{{handoff_rule}}')
  expect(await renderBriefFor([briefTask({})], 0)).toContain('      Refs hp-1\n')
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

const TASK_REVIEW_PROMPTS = ['spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality']

// Eight of the eighteen berean-os BLOCKER verdicts prevented no defect: they were
// BLOCKERs by rule — a missing FILES: line, a sound reversal, a question the
// orchestrator answered in a minute — and each cost a full re-review.
test('every task review ranks a BLOCKER as a shipping defect or an owner\'s call, never a process question', async () => {
  for (const name of TASK_REVIEW_PROMPTS) {
    const text = prose(await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text())
    expect(text, name).toContain(
      'A **BLOCKER** is a defect that would ship, or a product or scope decision only the owner can make.')
    expect(text, name).toContain(
      'A **MAJOR** changes shipped behaviour or a verification outcome; a wrong rationale behind a correct ' +
      'conclusion, comment drift or citation drift is **MINOR**.')
    expect(text, name).toContain('is at most a MAJOR, fixed inline or raised with `{{hpipe}} decide`, ' +
      'and never a reason for another review pass.')
    expect(text, name).toContain('`BLOCKER` means at least one BLOCKER finding.')
    expect(text, name).not.toContain('any MAJOR that reverses a decision')
  }
})

test('every task review reports at most five MINORs and skips drift that misleads nobody', async () => {
  for (const name of TASK_REVIEW_PROMPTS) {
    expect(prose(await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()), name).toContain(
      'Report at most five MINORs, most consequential first; skip wording and line-citation drift unless it ' +
      'would mislead the implementer or the tester.')
  }
})

test('every BLOCKER trailer a task review shows carries at least one BLOCKER', async () => {
  for (const name of TASK_REVIEW_PROMPTS) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    const shown = /^ {4}VERDICT: BLOCKER\n {4}BLOCKERS: (\d+)$/m.exec(text)
    expect(Number(shown?.[1] ?? 0), name).toBeGreaterThan(0)
  }
})

test('a file missing from FILES: is a MAJOR the plan review fixes inline, not a BLOCKER', async () => {
  const text = prose(await Bun.file(join(ROOT, 'prompts', 'plan-review.md')).text())
  expect(text).toContain('a touched file missing from them is a MAJOR, fixed inline by adding it')
  expect(text).not.toContain('missing from them is a BLOCKER')
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
  const task = { task_id: 't1', branch: 'feat/x', bead: 'hp-1' } as Task
  const base = { commit: 'c0ffee1', ref: 'origin/main', fetchError: null }
  const printed = dispatchSequence(run, task, base, { kind: 'none' }, 'hp')
  const startLine = printed.split('\n').find((line) => line.includes('herdr agent start'))!.trim()
  expect(text).toContain(startLine.replace('start hp-1 ', 'start <name> ')
    .replace('<.result.root_pane.pane_id>', '<root_pane_id>').replace('--effort xhigh', '--effort <effort>'))
  // The template is the one place the name stays a placeholder, so it says what goes there.
  expect(text).toContain('`<name>` is')
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
  expect(text).toContain('Batch context the bead does not carry: land after t1')
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
  // Named rather than counted: `bead:` appears only when --title filed one, and
  // a count is how the convention drifted before.
  const text = await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text()
  for (const line of ['task_id:', 'tier:', 'bead:', 'files:', 'bootstrap:', 'base:']) {
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

const MODES: readonly RunMode[] = ['per-task', 'single-pr']

/** A run of `mode`, or of the one mode `phase` runs in. */
function runIn(mode: RunMode): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  return mode === 'single-pr' ? withBatch(run, batchFixture()) : run
}

async function renderPhase(
  phase: TaskPhase, over: Partial<Task> = {}, cameFrom: TaskPhase = phase,
  mode: RunMode = rowRunsIn(taskRow(phase), 'per-task') ? 'per-task' : 'single-pr',
): Promise<string> {
  const run = runIn(mode)
  const task = briefTask({ phase, pr: 7, ...over })
  run.tasks = [task]
  return renderTaskPhasePrompt(run, task, { pluginRoot: ROOT, ciDetail: async () => '- build (fail)' }, cameFrom)
}

// Smoke run 14: a CLEAR carried a MINOR, the worker pushed only the verdict, and the
// MINOR shipped while the land prompt said "Review cleared".
test('every task review tells the worker to fix a CLEAR\'s findings this turn and push them with the verdict', async () => {
  const PUSHED_LATER = 'Pushed later, a fix moves the branch off the head the `CLEAR` recorded, and sends the ' +
    'change through `sync` and another review.'
  for (const phase of TASK_REVIEW_PROMPTS as TaskPhase[]) {
    for (const mode of MODES) {
      const workerPart = prose(await renderPhase(phase, { tier: 'standard' }, phase, mode))
        .split("## The reviewer's brief")[0]!
      expect(workerPart, `${phase} ${mode}`).toContain('On a `CLEAR`, fix the MAJORs and MINORs it lists in this ' +
        'same turn')
      expect(workerPart, `${phase} ${mode}`).toContain('commit and push the fixes with the verdict file before you ' +
        'end it')
      const landsNext = phase.startsWith('pr-review') && mode === 'single-pr'
      expect(workerPart.includes(PUSHED_LATER), `${phase} ${mode}`).toBe(landsNext)
    }
  }
  const run = runIn('single-pr')
  run.phase = 'branch-review'
  expect(prose(await renderRunPhasePrompt(run, ROOT)))
    .toContain('On a `CLEAR`, fix the MAJORs and MINORs it lists yourself before you go idle')
})

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

test('every reviewer is dispatched at the review effort, with a fallback if the effort is refused', async () => {
  for (const name of REVIEW_PROMPTS) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    expect(text, name).toContain('`effort: {{review_effort}}`')
    expect(text, name).toContain('If the dispatch is rejected for its effort, dispatch without `effort:`')
  }
})

test('a review is dispatched at its task\'s tier effort for that review', async () => {
  for (const phase of ['spec-review', 'pr-review'] as const) {
    expect(await renderPhase(phase, { tier: 'standard' }), phase).toContain('`effort: high`')
  }
  expect(await renderPhase('plan-review', { tier: 'standard' })).toContain('`effort: medium`')
  for (const phase of ['spec-review', 'plan-review', 'pr-review', 'pr-review-intent', 'pr-review-quality'] as const) {
    expect(await renderPhase(phase, { tier: 'heavy' }), phase).toContain('`effort: xhigh`')
  }
})

// About 59% of berean-os plan-review BLOCKER/MAJOR findings were compile and
// command errors the implementer's red/green loop hits minutes later, and
// reviewers often applied the whole plan in a scratch copy to find them.
test('the plan review reads the plan for what nothing downstream checks, and neither applies nor builds it', async () => {
  const text = prose(await Bun.file(join(ROOT, 'prompts', 'plan-review.md')).text())
  expect(text).toContain('Read the plan; do not apply it or build it.')
  expect(text).toContain('an error the plan\'s own red/green steps or the build would show at once')
  for (const focus of [
    '**Spec coverage.**', '**Behaviour the tests cannot see.**', '**The file lock.**',
    '**Steps that would mislead the implementer.**',
  ]) {
    expect(text, focus).toContain(focus)
  }
  expect(text).not.toContain('execute this plan literally')
  expect(text).toContain('a step that pushes, opens a PR or runs `{{hpipe}} submit` is a MINOR')
})

// "The plan tells the implementer to push and open the PR" recurred in eight or
// more berean-os plan reviews, rated MAJOR, MINOR or no finding at all.
test('a plan stops at implementation: pushing and the hand-off after it are the worker\'s', async () => {
  for (const mode of MODES) {
    const text = prose(await renderPhase('plan', {}, 'plan', mode))
    expect(text, mode).toContain('The plan ends at implementation.')
    expect(text, mode).toContain('Write no step that pushes, opens a PR or runs `')
    expect(text, mode).toContain(' submit`')
    expect(text, mode).toContain('leave out its execution hand-off')
  }
  const brief = prose(implementersBrief(await Bun.file(join(ROOT, 'prompts', 'implement.md')).text()))
  expect(brief).toContain('If the plan has a step that pushes, opens a PR or runs `{{hpipe}} submit`, skip it')
})

test('the branch review runs at the effort of the heaviest task in the run', async () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'branch-review'
  run.tasks = [briefTask({ task_id: 't1', phase: 'done', tier: 'light' })]
  expect(await renderRunPhasePrompt(run, ROOT)).toContain('`effort: high`')
  run.tasks.push(briefTask({ task_id: 't2', phase: 'done', tier: 'heavy' }))
  expect(await renderRunPhasePrompt(run, ROOT)).toContain('`effort: xhigh`')
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
  expect(await renderPhase('pr-review', { tier: 'heavy', verdict_seq: { 'spec-review': 1 } }))
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
  expect(heavy).toContain('7. `pr-review` — one review of the PR, intent then quality')
  expect(heavy).not.toContain('pr-review-intent')
  expect(heavy).not.toContain('pr-review-quality')
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

test('the per-task merge prompt renders the merge command, with the way out when squash is off', async () => {
  const text = await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 } })
  expect(text).toContain('\n    gh pr merge 7 --squash\n')
  expect(prose(text)).toContain('Green is for the head CI ran on. If you push to the branch')
  expect(prose(text)).toContain('If this repo does not allow squash merges, swap `--squash` for the method it does ' +
    'allow, `--merge` or `--rebase`.')
})

// Smoke run 15: the merge prompt said "green is for the head CI ran on" without naming it,
// and its command would merge whatever head the PR had by then.
test('the per-task merge prompt pins the head CI passed on, and names it', async () => {
  const sha = 'c0ffee12' + '0'.repeat(32)
  const pinned = await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 }, ci: 'pass',
    ci_head: { sha, seen_at: 1 } })
  expect(pinned).toContain(`\n    gh pr merge 7 --squash --match-head-commit ${sha}\n`)
  expect(prose(pinned)).toContain('Green is for `c0ffee12`, the head CI ran on: the command below merges only while ' +
    "the PR's head is still that commit. If you push to the branch")

  const noHead = await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 }, ci: 'pass' })
  expect(noHead).toContain('\n    gh pr merge 7 --squash\n')
  const notGreen = await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 }, ci: 'fail',
    ci_head: { sha, seen_at: 1 } })
  expect(notGreen).toContain('\n    gh pr merge 7 --squash\n')
  expect(notGreen).not.toContain('--match-head-commit')
})

test('the per-task merge prompt calls CI green only when a pass is recorded', async () => {
  expect(await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 }, ci: 'pass' }))
    .toContain('Review cleared and CI is green on PR #7.')
  for (const ci of [null, 'pending', 'fail'] as const) {
    const text = await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 }, ci })
    expect(text, String(ci)).not.toContain('CI is green')
    expect(text, String(ci)).toContain('Review cleared, but no green CI is recorded on PR #7. Check it first, and ' +
      'merge only once every check passes:\n\n    gh pr checks 7\n')
  }
})

test('merge counts the review stages that actually ran', async () => {
  expect(await renderPhase('merge', { tier: 'heavy', verdict_seq: { 'pr-review-intent': 1, 'pr-review-quality': 1 }, ci: 'pass' }))
    .toContain('Both review stages cleared and CI is green on PR #7.')
  expect(await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 }, ci: 'pass' }))
    .toContain('Review cleared and CI is green on PR #7.')
})

test('merge says the PR review was skipped, and the batch landing names the head as submitted, not reviewed', async () => {
  const review_skip = { at: 1, skipped: ['pr-review'] as TaskPhase[], added_lines: 12, cleared: ['spec-review'] as TaskPhase[] }
  const skipped = 'The PR review was skipped (12 lines added outside docs/, spec-review cleared first pass)'
  expect(prose(await renderPhase('merge', { tier: 'light', review_skip, ci: 'pass' })))
    .toContain(`${skipped} and CI is green on PR #7.`)
  expect(prose(await renderPhase('merge', { tier: 'light', review_skip, land_sha: 'abcdef1234' }, 'merge', 'single-pr')))
    .toContain(`${skipped}, and \`abcdef12\` is the head that was submitted`)
  expect(await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 }, land_sha: 'abcdef1234' }, 'merge', 'single-pr'))
    .toContain('Review cleared, and `abcdef12` is the head that was reviewed')
})

test('the batch landing names a clean sync as one, on top of the head that was reviewed or submitted', async () => {
  // Smoke run 14 called a clean sync's head "the head that was reviewed".
  const sync = { kind: 'sync' as const, title: 't', head_sha: '13f910ea0000', at: 1, check: 'passed' as const,
    merge: 'clean' as const }
  const reviewed = { tier: 'light' as const, verdict_seq: { 'pr-review': 1 }, land_sha: '13f910ea0000', submission: sync }
  expect(prose(await renderPhase('merge', reviewed, 'merge', 'single-pr'))).toContain('Review cleared, and ' +
    '`13f910ea` is a clean sync of `batch/x` on top of the reviewed head, checked. It contains every landing')
  const review_skip = { at: 1, skipped: ['pr-review'] as TaskPhase[], added_lines: 12, cleared: ['spec-review'] as TaskPhase[] }
  expect(prose(await renderPhase('merge', { ...reviewed, review_skip }, 'merge', 'single-pr')))
    .toContain('`13f910ea` is a clean sync of `batch/x` on top of the submitted head, checked.')
  const implemented = { ...sync, kind: 'implement' as const, merge: undefined, head_sha: 'aaaa1111' }
  expect(prose(await renderPhase('merge', { ...reviewed, land_sha: 'aaaa1111', submission: implemented }, 'merge',
    'single-pr'))).toContain('`aaaa1111` is the head that was reviewed and checked.')
})

// Smoke run 15: the check ran on the sync submission, the CLEAR recorded the head that
// adds the review file, and the land prompt called that head "reviewed and checked".
test('the batch landing says where the check ran when the reviewed head only adds review verdicts to it', async () => {
  const onlyVerdicts = 'The check ran on `e461a2f0`, and `ebcd8194` adds nothing to it but review verdicts under ' +
    '`docs/superpowers/reviews/`, which no check tests. It contains every landing'
  for (const [kind, merge] of [['implement', undefined], ['sync', 'dirty'], ['sync', 'clean']] as const) {
    const submission = { kind, title: 't', head_sha: 'e461a2f00000', at: 1, check: 'passed' as const,
      ...(merge === undefined ? {} : { merge }) }
    const text = prose(await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 },
      land_sha: 'ebcd81940000', submission }, 'merge', 'single-pr'))
    expect(text, `${kind} ${merge}`).toContain(`Review cleared, and \`ebcd8194\` is the head that was reviewed. ${onlyVerdicts}`)
    expect(text, `${kind} ${merge}`).not.toContain('clean sync')
  }
  const review_skip = { at: 1, skipped: ['pr-review'] as TaskPhase[], added_lines: 12, cleared: ['spec-review'] as TaskPhase[] }
  const submitted = { kind: 'implement' as const, title: 't', head_sha: 'e461a2f00000', at: 1, check: 'passed' as const }
  expect(prose(await renderPhase('merge', { tier: 'light', review_skip, land_sha: 'ebcd81940000', submission: submitted },
    'merge', 'single-pr'))).toContain(`\`ebcd8194\` is the head recorded when its PR review was skipped. ${onlyVerdicts}`)
  const unchecked = { kind: 'implement' as const, title: 't', head_sha: 'e461a2f00000', at: 1, check: 'none' as const }
  expect(prose(await renderPhase('merge', { tier: 'light', verdict_seq: { 'pr-review': 1 }, land_sha: 'ebcd81940000',
    submission: unchecked }, 'merge', 'single-pr')))
    .toContain('Review cleared, and `ebcd8194` is the head that was reviewed. It contains every landing')
})

test('sync tells a worker whose review was skipped that it was, not that it was reviewed', async () => {
  const review_skip = { at: 1, skipped: ['pr-review'] as TaskPhase[], added_lines: 12, cleared: ['spec-review'] as TaskPhase[] }
  expect(prose(await renderPhase('sync', { tier: 'light', land_sha: 'abc', review_skip })))
    .toContain('Your change skipped its PR review as a small change, and it is next in line to land')
  expect(prose(await renderPhase('sync', { tier: 'light', land_sha: 'abc' })))
    .toContain('Your change was reviewed, and it is next in line to land')
})

// Smoke run 15: a worker that resolved a conflict was told only that a commit beyond the
// merge goes back to review, and read its resolved merge as one that would land as is.
test('sync says a resolved conflict goes through review, like any commit beyond the automatic merge', async () => {
  const text = prose(await renderPhase('sync', { tier: 'light', land_sha: 'abc' }))
  expect(text).toContain('**Wait for it within this turn.** A merge whose conflict you resolved is not a clean ' +
    'merge: `submit` sends the change through review before it lands, because the resolution is code no ' +
    'reviewer has seen.')
  expect(text).toContain('Only a merge git made on its own, left as git made it, lands without another review: a ' +
    'resolved conflict, an edit to the merge, or any commit after it sends this branch through review. That ' +
    'is expected, not a failure.')
  expect(text).not.toContain('Any commit beyond the merge')
})

test('a review after a skipped review and a dirty sync reads the whole change, not a range since a review', async () => {
  const sync = { kind: 'sync' as const, title: 't', head_sha: 'eeee5555', at: 1, check: 'passed' as const,
    merge: 'dirty' as const, dirty_at: 'ffff66660000' }
  expect(await renderPhase('pr-review', { tier: 'light', land_sha: 'aaaa1111', submission: sync }, 'sync', 'single-pr'))
    .toContain('since the last reviewed head')
  expect(await renderPhase('pr-review', { tier: 'light', submission: sync }, 'sync', 'single-pr'))
    .not.toContain('since the last reviewed head')
})

// Smoke run 15: the first review of a skipped-review change after a conflicted sync got
// only the generic brief, and nothing pointed it at the resolution.
test('the first review after a dirty sync is told to read the whole diff and the conflict resolution', async () => {
  const sync = { kind: 'sync' as const, title: 't', head_sha: 'eeee5555', at: 1, check: 'passed' as const,
    merge: 'dirty' as const, dirty_at: 'ffff66660000' }
  const opening = 'This review was entered from a sync of `batch/x` that was not a clean merge'
  const firstReview = 'No reviewed head is recorded, so this is the change\'s first review: read the whole diff.'
  const atDirty = prose(await renderPhase('pr-review', { tier: 'light', submission: sync }, 'sync', 'single-pr'))
  expect(atDirty).toContain(`${opening} (at \`ffff6666\`). ${firstReview} Then read the conflict resolution, ` +
    'which no reviewer has seen, with `git show --remerge-diff ffff66660000`, and if that commit is not a merge, ' +
    'the same for each merge in `git log --first-parent --merges origin/batch/x..origin/feat/x`.')

  const { dirty_at: _, ...undated } = sync
  const noDirtyAt = prose(await renderPhase('pr-review', { tier: 'light', submission: undated }, 'sync', 'single-pr'))
  expect(noDirtyAt).toContain(`${opening}. ${firstReview} Then read each conflict resolution, which no reviewer ` +
    'has seen, with `git show --remerge-diff <merge>` for each merge in ' +
    '`git log --first-parent --merges origin/batch/x..origin/feat/x`.')

  const clean = { ...sync, merge: 'clean' as const }
  expect(await renderPhase('pr-review', { tier: 'light', submission: clean }, 'sync', 'single-pr'))
    .not.toContain(opening)
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
  for (const [tier, mode] of TIERS.flatMap((t) => MODES.map((m) => [t, m] as const))) {
    const rendered: Array<[string, string]> = []

    for (const row of TASK_ROWS.filter((r) => r.prompt !== undefined && rowRunsIn(r, mode))) {
      rendered.push([row.phase, await renderPhase(row.phase, { tier, escalated_from: 'implement' }, row.phase, mode)])
    }
    rendered.push(['merge', await renderPhase('merge', { tier, land_sha: 'abc' }, 'merge', mode)])
    rendered.push(['implement from blocked-on-files', await renderPhase('implement', { tier }, 'blocked-on-files', mode)])
    if (mode === 'per-task') rendered.push(['implement from ci', await renderPhase('implement', { tier }, 'ci')])

    const run = runIn(mode)
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

    for (const [what, text] of rendered) expect(text, `${tier} ${mode}: ${what}`).not.toContain('{{')
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

test('the decision prompt has the orchestrator escalate whatever it puts to the human', async () => {
  const text = prose(await Bun.file(join(ROOT, 'prompts', 'decision.md')).text())
  expect(text).toContain('{{hpipe}} escalate --task {{task_id}} --decision {{decision_id}}')
  expect(text).toContain('--recommend')
  expect(text).toContain('the brief (`{{hpipe}} brief --task {{task_id}}`)')
})

test('the worker sends out-of-scope work to discover, and the branch review files it', async () => {
  const brief = prose(await Bun.file(join(ROOT, 'prompts', 'worker-brief.md')).text())
  expect(brief).toContain('{{hpipe}} discover --task {{task_id}} --title "<title>" --body-file <path>')
  expect(prose(await renderBriefFor([briefTask({})], 0))).toContain('not into this PR')
  // A plugin bug recorded as a discovery was filed into the repo's own backlog. Measured on a live run.
  expect(brief).toContain('Discoveries are follow-up work for this repo')
  expect(brief).toContain('a problem with the pipeline itself')
  const review = prose(await Bun.file(join(ROOT, 'prompts', 'branch-review.md')).text())
  expect(review).toContain('{{hpipe}} discoveries')
  expect(review).toContain('{{hpipe}} discoveries --file')
  expect(review).toContain('stops at the first failure')
  expect(review).not.toContain('all-or-nothing')
})

test('intake and registration start from the backlog, adopt with --bead, and never run bd or bv', async () => {
  for (const name of ['intake', 'dispatch-registering']) {
    const text = prose(await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text())
    expect(text, name).toContain('{{hpipe}} next')
    expect(text, name).toContain('--bead <id>')
    expect(text, name).toContain('--acceptance-file <path>')
    expect(text, name).toContain('Never run `bd` or `bv` yourself')
    expect(text, name).toContain('know nothing about files')
    expect(text, name).not.toContain('gh issue')
    expect(text, name).not.toContain('--issue')
    expect(text, name).not.toContain('share no dependency')
  }
  const intake = prose(await Bun.file(join(ROOT, 'prompts', 'intake.md')).text())
  expect(intake).toContain('`bead: <id> (filed)`')
  expect(intake).toContain('{{hpipe}} bead show <id>')
  expect(intake).toContain('later dependency layer')
})

test('dispatch says the bead\'s captured brief is the brief, and that dispatch claims the bead', async () => {
  const text = prose(await Bun.file(join(ROOT, 'prompts', 'dispatch.md')).text())
  expect(text).toContain('the bead\'s brief, captured at registration, is the brief')
  expect(text).toContain('claims the task\'s bead first')
  expect(text).not.toContain('issue')
})

test('the branch review finds the run\'s PRs in the ledger, not by searching GitHub issues', async () => {
  const run = runIn('per-task')
  run.phase = 'branch-review'
  const text = prose(await renderRunPhasePrompt(run, ROOT))
  expect(text).toContain(`\`${hpipeCommand(ROOT)} show --task <id>\` prints each task's \`pr:\``)
  expect(text).not.toContain('gh pr list')
})

test('the skill teaches the Beads commands and the rule against running bd', async () => {
  const skill = await Bun.file(join(ROOT, 'skills', 'herdr-pipeline', 'SKILL.md')).text()
  for (const needle of [
    'hpipe next', 'hpipe bead show <id>', '--bead <id>', '--prefix', 'hpipe escalate --task',
    'hpipe discoveries --file', 'hpipe close --task', 'Never run `bd` or `bv` yourself',
  ]) {
    expect(skill, needle).toContain(needle)
  }
  expect(skill).not.toContain('GitHub issue')
  expect(skill).not.toContain('--issue')
  expect(skill).not.toContain('share no dependency')
})

test('the README documents Beads setup, backups, the br and reclaim warnings and bv\'s licence rider', async () => {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  for (const needle of [
    '## Beads', 'brew install beads', 'brew install dicklesworthstone/tap/bv', 'Set up Beads for this repo',
    'hpipe start --prefix', 'Back up `$HERDR_PLUGIN_STATE_DIR/beads`', 'Never install `br`', 'Open board',
    'Never run `bd reclaim`', 'must start with a letter',
    '"Restricted Parties" means OpenAI, L.L.C.; Anthropic, PBC;',
    'https://github.com/Dicklesworthstone/beads_viewer/blob/main/LICENSE',
  ]) {
    expect(readme, needle).toContain(needle)
  }
  expect(readme).not.toContain('--issue <n>')
  expect(readme).not.toContain('gh issue create')
  expect(readme).not.toContain('independent tracks')
})

test('the README, the skill and intake give heavy the same one combined PR review', async () => {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  expect(readme).toContain('| `heavy` | ✓ | ✓ | one combined `pr-review`, never skipped |')
  const skill = prose(await Bun.file(join(ROOT, 'skills', 'herdr-pipeline', 'SKILL.md')).text())
  expect(skill).toContain('every tier gets one combined `pr-review`')
  expect(skill).not.toContain('heavy runs `pr-review-intent` then `pr-review-quality`')
  const intake = prose(await Bun.file(join(ROOT, 'prompts', 'intake.md')).text())
  expect(intake).toContain('Every tier gets one combined PR review')
  expect(intake).not.toContain('two separate stages')
  expect(await Bun.file(join(ROOT, 'prompts', 'pr-review.md')).text()).not.toContain('the heavy tier splits')
})

// Smoke run 15: intake and the skill said every tier gets a PR review, and the
// orchestrator met the skip only when a task went past it.
test('where tiers are introduced, the README, the skill and intake say a small change skips its PR review', async () => {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  expect(readme).toContain('| `light` | ✓ | – | one combined `pr-review`, skipped for a small change (below) |')
  expect(readme).toContain('| `standard` | ✓ | ✓ | one combined `pr-review`, skipped for a small change (below) |')
  const skill = prose(await Bun.file(join(ROOT, 'skills', 'herdr-pipeline', 'SKILL.md')).text())
  expect(skill).toContain('every tier gets one combined `pr-review`, except a light or standard task with a small ' +
    'change, which skips it (the `pr-review skipped` row under **While it runs**); heavy never skips it')
  const intake = prose(await Bun.file(join(ROOT, 'prompts', 'intake.md')).text())
  expect(intake).toContain('Every tier gets one combined PR review, except that a light or standard task whose ' +
    "change turns out small skips it (the herdr-pipeline skill's `pr-review skipped` row has the rule); `heavy` " +
    'never skips it')
})

test('the README and the skill name the PR review skip, its threshold and the always-review file', async () => {
  const readme = prose(await Bun.file(join(ROOT, 'README.md')).text())
  for (const needle of [
    'A small, well-planned change skips its PR review.', 'fewer than 150 lines outside `docs/`',
    '`PR_REVIEW_SKIP_BELOW_ADDED_LINES`', '`.claude/pipeline-always-review`', 'Heavy never skips',
  ]) {
    expect(readme, needle).toContain(needle)
  }
  const skill = prose(await Bun.file(join(ROOT, 'skills', 'herdr-pipeline', 'SKILL.md')).text())
  expect(skill).toContain('`pr-review skipped`')
  expect(skill).toContain('`.claude/pipeline-always-review`')
})
