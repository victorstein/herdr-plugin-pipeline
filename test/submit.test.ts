import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdSubmit, type SubmitDeps } from '../src/cli'
import { forgetDispatchBases } from '../src/lib/dispatch-base'
import { listRuns, loadRun, newRun, saveRun, withBatch } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
import { batchFixture } from './helpers/batch'
import { beadTaskFields } from './helpers/bead-fields'
import { cleanupFixtures, cloneOfRemote, commitAs, git, landOnRemote, revParse, tempDir } from './helpers/git-worktree'

let dir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'submit-')) })
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  forgetDispatchBases()
  cleanupFixtures()
})

interface Fixture { remote: string; clone: string; worktree: string; run: Run }

const ENTERED = 1_000

/** A single-PR run whose t1 works in a real linked worktree, cut from a real batch branch on a bare origin. */
async function fixture(over: Partial<Task> = {}, batchOver: Parameters<typeof batchFixture>[0] = {}): Promise<Fixture> {
  const { remote, clone } = cloneOfRemote('main')
  git(['push', '-q', 'origin', 'HEAD:refs/heads/batch/x'], clone)
  git(['fetch', '-q', 'origin', '+refs/heads/batch/x:refs/remotes/origin/batch/x'], clone)
  const worktree = join(tempDir('hpipe-wt-'), 'wt')
  git(['worktree', 'add', '-q', '-b', 't1-branch', worktree, 'origin/batch/x'], clone)
  git(['config', 'user.email', 'test@example.com'], worktree)
  git(['config', 'user.name', 'Test'], worktree)
  const run = withBatch(newRun({ session: 'personal', socketPath: '/s', repoKey: clone, repoRoot: clone, title: 'menu' }),
    batchFixture({ base_commit: revParse(clone, 'origin/batch/x'), ...batchOver }))
  run.phase = 'execute'
  run.tasks = [task({ checkout_path: worktree, ...over })]
  await saveRun(dir, run)
  return { remote, clone, worktree, run }
}

function task(over: Partial<Task>): Task {
  return {
    task_id: 't1', branch: 't1-branch', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
    keep_worktree: false, workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
    phase: 'implement', phase_entered_at: ENTERED, escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: null, registered_at: 0, adopted_at: 0,
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    ...over,
  }
}

const NO_PR: SubmitDeps = { openPr: async () => ({ pr: null }) }

const submit = (f: Fixture, title: string | null = 'feat(menu): close on escape', deps: Partial<SubmitDeps> = {}) =>
  cmdSubmit(ctx(), { taskId: 't1', title, repoKey: null, runId: f.run.run_id }, { ...NO_PR, ...deps })

const saved = async (f: Fixture): Promise<Task> => (await loadRun(dir, 'personal', f.run.run_id))!.tasks[0]!

function work(f: Fixture, rel = 'src/menu.ts', body = 'export const close = true\n'): string {
  commitAs(f.worktree, rel, body)
  git(['push', '-q', 'origin', 'HEAD:refs/heads/t1-branch'], f.worktree)
  return revParse(f.worktree, 'HEAD')
}

function declareCheck(f: Fixture, script: string, mode = 0o755): void {
  mkdirSync(join(f.worktree, '.claude'), { recursive: true })
  writeFileSync(join(f.worktree, '.claude', 'pipeline-check'), script)
  chmodSync(join(f.worktree, '.claude', 'pipeline-check'), mode)
  git(['add', '-A'], f.worktree)
  git(['commit', '-qm', 'chore: declare the check'], f.worktree)
}

test('a pushed, committed change with a release-note title is recorded as the implement submission', async () => {
  const f = await fixture()
  const head = work(f)
  const out = await submit(f)
  expect(out.ok).toBe(true)
  expect(out.text).toContain(`submitted t1 at ${head.slice(0, 8)} as "feat(menu): close on escape"`)
  const t1 = await saved(f)
  expect(t1.submission).toMatchObject({ kind: 'implement', title: 'feat(menu): close on escape', head_sha: head, check: 'none' })
  expect(t1.submission!.at).toBeGreaterThanOrEqual(ENTERED)
})

test('a per-task run, or a task in another phase, has nothing to submit', async () => {
  const f = await fixture()
  const perTask = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: f.clone, title: 'p' })
  perTask.tasks = [task({ checkout_path: f.worktree })]
  await saveRun(dir, perTask)
  const refused = await cmdSubmit(ctx(), { taskId: 't1', title: 'fix: x', repoKey: null, runId: perTask.run_id }, NO_PR)
  expect(refused.text).toContain('a per-task run')

  const reviewing = await fixture({ phase: 'pr-review' })
  work(reviewing)
  expect((await submit(reviewing)).text).toContain('t1 is in pr-review')
})

test('implement needs a title that is one release-note line release-please reads', async () => {
  const f = await fixture()
  work(f)
  expect((await submit(f, null)).text).toContain('--title is required')
  expect((await submit(f, 'close the menu')).text).toContain('one conventional line')
  expect((await submit(f, 'feet: close the menu')).text).toContain('`feet` is not one')
  expect((await saved(f)).submission).toBeUndefined()
})

test('a type the repo hides from its notes passes, and says it will not appear', async () => {
  const f = await fixture()
  writeFileSync(join(f.worktree, 'release-please-config.json'),
    JSON.stringify({ 'changelog-sections': [{ type: 'feat' }, { type: 'chore', hidden: true }] }))
  work(f)
  const out = await submit(f, 'chore: tidy')
  expect(out.ok).toBe(true)
  expect(out.text).toContain('hidden')
})

test('uncommitted or untracked work is refused: the check must test the pushed tree', async () => {
  const f = await fixture()
  work(f)
  writeFileSync(join(f.worktree, 'src/menu.ts'), 'changed\n')
  expect((await submit(f)).text).toContain('uncommitted')
  git(['checkout', '-q', '--', 'src/menu.ts'], f.worktree)
  writeFileSync(join(f.worktree, 'stray.ts'), 'new\n')
  expect((await submit(f)).text).toContain('stray.ts')
  writeFileSync(join(f.worktree, '.gitignore'), 'stray.ts\n')
  git(['add', '.gitignore'], f.worktree)
  git(['commit', '-qm', 'chore: ignore'], f.worktree)
  git(['push', '-q', 'origin', 'HEAD:refs/heads/t1-branch'], f.worktree)
  expect((await submit(f)).ok).toBe(true)
})

test('a head origin has not got is refused: push first', async () => {
  const f = await fixture()
  work(f)
  commitAs(f.worktree, 'src/more.ts', 'more\n')
  expect((await submit(f)).text).toContain('push first')
})

test('a branch with nothing outside its own docs is refused: nothing to land', async () => {
  const f = await fixture()
  git(['push', '-q', 'origin', 'HEAD:refs/heads/t1-branch'], f.worktree)
  expect((await submit(f)).text).toContain('nothing to land: t1-branch has no change that batch/x lacks')
  work(f, 'docs/superpowers/specs/2026-10-11-hp-1-design.md', 'spec\n')
  expect((await submit(f)).text).toContain('nothing to land')
})

test('back in implement, nothing but a merge of the batch since the review is refused', async () => {
  const f = await fixture()
  const reviewed = work(f)
  const run = (await loadRun(dir, 'personal', f.run.run_id))!
  run.tasks[0]!.head_sha_at_entry = reviewed
  await saveRun(dir, run)
  landOnRemote(f.remote, 'batch/x')
  git(['fetch', '-q', 'origin', '+refs/heads/batch/x:refs/remotes/origin/batch/x'], f.worktree)
  git(['merge', '-q', '--no-edit', 'origin/batch/x'], f.worktree)
  git(['push', '-q', 'origin', 'HEAD:refs/heads/t1-branch'], f.worktree)
  expect((await submit(f)).text).toContain('nothing but merges of batch/x since the review sent it back')

  work(f, 'src/fix.ts', 'fixed\n')
  expect((await submit(f)).ok).toBe(true)
})

test('a branch with an open PR is refused: that PR would carry every sibling into the default branch', async () => {
  const f = await fixture()
  work(f)
  const out = await submit(f, undefined, { openPr: async () => ({ pr: 31 }) })
  expect(out.ok).toBe(false)
  expect(out.text).toContain('Close PR #31, then submit again')
})

test('a gh that cannot say whether the branch has an open PR is a refusal, not a pass', async () => {
  const f = await fixture()
  work(f)
  let checked = false
  const out = await submit(f, undefined, {
    openPr: async () => ({ error: 'HTTP 502: Bad Gateway' }),
    runCheck: async () => { checked = true; return { code: 0, tail: '' } },
  })
  expect(out.ok).toBe(false)
  expect(out.text).toContain('could not ask GitHub whether t1-branch has an open PR (HTTP 502: Bad Gateway)')
  expect(checked).toBe(false)
  expect((await saved(f)).submission).toBeUndefined()
})

test('a declared check runs on the pushed tree; passing, it is recorded', async () => {
  const f = await fixture()
  declareCheck(f, '#!/bin/sh\necho checking\nexit 0\n')
  const head = work(f)
  const out = await submit(f)
  expect(out.ok).toBe(true)
  expect(out.text).toContain('check passed')
  expect((await saved(f)).submission?.check).toBe('passed')
  const log = join(dir, 'runs', 'personal', `${f.run.run_id}.checks`, `t1-${head.slice(0, 8)}.log`)
  expect(readFileSync(log, 'utf8')).toContain('checking')
})

test('a failing check refuses, prints its last lines and where the whole log is', async () => {
  const f = await fixture()
  const lines = Array.from({ length: 60 }, (_, i) => `echo line-${i}`).join('\n')
  declareCheck(f, `#!/bin/sh\n${lines}\nexit 3\n`)
  work(f)
  const out = await submit(f)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('.claude/pipeline-check failed (exit 3)')
  expect(out.text).toContain('line-59')
  expect(out.text).toContain('line-20')
  expect(out.text).not.toContain('line-19\n')
  expect(out.text).toContain('.checks/t1-')
  expect((await saved(f)).submission).toBeUndefined()
})

test('a check that is not executable refuses with the chmod hint', async () => {
  const f = await fixture()
  declareCheck(f, '#!/bin/sh\nexit 0\n', 0o644)
  work(f)
  const out = await submit(f)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('chmod +x .claude/pipeline-check')
})

test('a stale save is retried without running the check again', async () => {
  const f = await fixture()
  declareCheck(f, '#!/bin/sh\nexit 0\n')
  work(f)
  let checks = 0
  const out = await submit(f, undefined, {
    runCheck: async (checkout, log) => {
      checks++
      const { runCheck } = await import('../src/lib/check')
      const result = await runCheck(checkout, log)
      if (checks === 1) {
        const meanwhile = (await loadRun(dir, 'personal', f.run.run_id))!
        meanwhile.history.push({ at: 1, from: 'x', to: 'x', why: 'the supervisor wrote meanwhile' })
        await saveRun(dir, meanwhile)
      }
      return result
    },
  })
  expect(out.ok).toBe(true)
  expect(checks).toBe(1)
  expect((await saved(f)).submission?.check).toBe('passed')
})

test('a submit outlasting many supervisor saves still lands: only the record is retried, never the checks', async () => {
  const f = await fixture()
  declareCheck(f, '#!/bin/sh\nexit 0\n')
  work(f)
  let saves = 0
  const supervisor = setInterval(async () => {
    const meanwhile = (await loadRun(dir, 'personal', f.run.run_id))!
    meanwhile.history.push({ at: saves, from: 'x', to: 'x', why: 'a supervisor tick' })
    await saveRun(dir, meanwhile).catch(() => {})
    saves++
  }, 50)
  let checks = 0
  const out = await submit(f, undefined, {
    openPr: async () => { await Bun.sleep(400); return { pr: null } },
    runCheck: async (checkout, log) => {
      checks++
      const { runCheck } = await import('../src/lib/check')
      const result = await runCheck(checkout, log)
      await Bun.sleep(400)
      return result
    },
  }).finally(() => clearInterval(supervisor))
  expect(saves).toBeGreaterThan(5)
  expect(out.ok).toBe(true)
  expect(checks).toBe(1)
  expect((await saved(f)).submission?.check).toBe('passed')
})

test('a task that moves on while submit runs its checks records nothing', async () => {
  const f = await fixture()
  work(f)
  const out = await submit(f, undefined, {
    openPr: async () => {
      const meanwhile = (await loadRun(dir, 'personal', f.run.run_id))!
      meanwhile.tasks[0]!.phase = 'pr-review'
      meanwhile.tasks[0]!.phase_entered_at = ENTERED + 5
      await saveRun(dir, meanwhile)
      return { pr: null }
    },
  })
  expect(out.ok).toBe(false)
  expect(out.text).toContain('moved on (now in pr-review) while submit ran its checks; nothing was recorded')
  expect((await saved(f)).submission).toBeUndefined()
})

test('a task waiting for the landing slot tells its worker to end the turn, not to submit again', async () => {
  const f = await fixture({ phase: 'land-queue', land_sha: 'L1' })
  work(f)
  const out = await submit(f)
  expect(out.ok).toBe(false)
  expect(out.text).toContain('t1 waits in land-queue for the landing slot; if it must sync when its turn comes, ' +
    'you are sent the sync prompt then — end your turn')
})

// ——— sync ———

async function reviewedAndBehind(): Promise<{ f: Fixture; reviewed: string }> {
  const f = await fixture()
  const reviewed = work(f)
  const run = (await loadRun(dir, 'personal', f.run.run_id))!
  const t1 = run.tasks[0]!
  t1.phase = 'sync'
  t1.land_sha = reviewed
  t1.submission = { kind: 'implement', title: 'feat(menu): close on escape', head_sha: reviewed, at: 500, check: 'none' }
  await saveRun(dir, run)
  landOnRemote(f.remote, 'batch/x')
  git(['fetch', '-q', 'origin', '+refs/heads/batch/x:refs/remotes/origin/batch/x'], f.worktree)
  return { f, reviewed }
}

test('sync: a branch still behind the batch is refused', async () => {
  const { f } = await reviewedAndBehind()
  expect((await submit(f, null)).text).toContain('still behind batch/x: merge it and push')
})

test('sync: a clean merge is recorded clean, keeping the implement title', async () => {
  const { f } = await reviewedAndBehind()
  git(['merge', '-q', '--no-edit', 'origin/batch/x'], f.worktree)
  git(['push', '-q', 'origin', 'HEAD:refs/heads/t1-branch'], f.worktree)
  const out = await submit(f, null)
  expect(out.ok).toBe(true)
  expect(out.text).toContain('a clean merge of batch/x')
  expect((await saved(f)).submission).toMatchObject({
    kind: 'sync', merge: 'clean', title: 'feat(menu): close on escape', head_sha: revParse(f.worktree, 'HEAD'),
  })
})

test('sync: anything beyond a clean merge is recorded dirty, with the commit that made it so', async () => {
  const { f } = await reviewedAndBehind()
  git(['merge', '-q', '--no-edit', 'origin/batch/x'], f.worktree)
  const extra = work(f, 'src/repair.ts', 'repair\n')
  const out = await submit(f, 'fix(menu): close on escape twice')
  expect(out.ok).toBe(true)
  expect(out.text).toContain('not a clean merge')
  expect((await saved(f)).submission).toMatchObject({
    kind: 'sync', merge: 'dirty', dirty_at: extra, title: 'fix(menu): close on escape twice',
  })
})

test('sync: with nothing to merge, the reviewed head itself is checked, and that is clean', async () => {
  const f = await fixture()
  const reviewed = work(f)
  const run = (await loadRun(dir, 'personal', f.run.run_id))!
  Object.assign(run.tasks[0]!, { phase: 'sync', land_sha: reviewed })
  await saveRun(dir, run)
  const out = await submit(f, 'feat(menu): close on escape')
  expect(out.ok).toBe(true)
  expect((await saved(f)).submission).toMatchObject({ kind: 'sync', merge: 'clean', head_sha: reviewed })
})

test('submit records nothing when it refuses', async () => {
  const f = await fixture()
  expect(existsSync(join(dir, 'runs', 'personal', `${f.run.run_id}.checks`))).toBe(false)
  await submit(f)
  expect((await listRuns(dir, 'personal'))[0]?.tasks[0]?.submission).toBeUndefined()
})
