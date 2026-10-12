import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdBatchCheck, cmdSubmit } from '../src/cli'
import type { Config } from '../src/lib/config'
import { forgetDispatchBases } from '../src/lib/dispatch-base'
import { listRuns, loadRun, saveRun } from '../src/lib/ledger'
import type { PrView } from '../src/lib/gh'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import { closeReason, recordBeadClosed } from '../src/supervisor/beads-sync'
import { fetchBatches } from '../src/supervisor/batch-fetch'
import { CI_SETTLE_MS, ciTransitions } from '../src/supervisor/ci'
import { absoluteArtifactPath, evaluateRun } from '../src/supervisor/deliver'
import { advanceTasks, renderTaskPhasePrompt, type TaskDeps } from '../src/supervisor/tasks'
import { cmdStart, startBatch } from './helpers/cmd-start'
import { cmdTask } from './helpers/cmd-task'
import { cleanupFixtures, cloneOfRemote, commitAs, git, revParse, tempDir } from './helpers/git-worktree'

/**
 * A two-task single-PR run from start to the squash merge, against a real ledger,
 * a real bare origin and real worktrees, with only herdr, gh and Beads faked:
 * the CLI and the supervisor's steps are driven in the order a live run takes
 * them. Unit tests with fakes have missed live-only wiring bugs before.
 */

const ROOT = join(import.meta.dir, '..')
let stateDir: string
const ctx = () => ({ stateDir, pluginRoot: ROOT, session: 'personal' })
const CONFIG = { MAX_PASSES: 2, FILE_SETTLE_MS: 0 } as Config

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  forgetDispatchBases()
  cleanupFixtures()
})

function sh(command: string, cwd: string): void {
  const proc = Bun.spawnSync(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (!proc.success) throw new Error(`${command}: ${proc.stderr.toString()}`)
}

const loaded = async (runId: string): Promise<Run> => (await loadRun(stateDir, 'personal', runId))!
const taskOf = (run: Run, id: string): Task => run.tasks.find((t) => t.task_id === id)!

const supervisorDeps = (verdicts: Map<string, 'CLEAR'>): TaskDeps => ({
  pluginRoot: ROOT,
  liveIdle: async () => true,
  hasLiveAgent: () => true,
  maxPasses: 2,
  fileSettleMs: 0,
  prForBranch: async () => { throw new Error('a single-PR run never looks for a task PR') },
  prView: async () => { throw new Error('a single-PR run never reads a task PR') },
  verdictFor: async (_run, task) => {
    const verdict = verdicts.get(task.task_id)
    if (verdict === undefined) return null
    verdicts.delete(task.task_id)
    return { verdict, blockers: 0, majors: 0 }
  },
  removeWorktree: async () => 'removed',
  removeCheckout: async () => ({ removed: true }),
  ciDetail: async () => '',
  ambiguityLog: new Set<string>(),
  uncommittedPaths: async () => [],
  freshDispatchBase: async () => { throw new Error('no task is dispatched by the supervisor here') },
})

/** One supervisor pass over the run, saved the way `main.ts` saves it. */
async function supervisorTick(runId: string, verdicts: Map<string, 'CLEAR'>): Promise<Run> {
  const run = await loaded(runId)
  await fetchBatches([run])
  await advanceTasks(run, supervisorDeps(verdicts))
  await saveRun(stateDir, run)
  return run
}

async function phases(runId: string): Promise<Record<string, TaskPhase>> {
  const run = await loaded(runId)
  return Object.fromEntries(run.tasks.map((t) => [t.task_id, t.phase]))
}

/** A worker: commit in its own worktree, push, submit. */
async function workAndSubmit(runId: string, taskId: string, worktree: string, rel: string, title: string | null) {
  commitAs(worktree, rel, `${rel}\n`)
  git(['push', '-q', 'origin', 'HEAD'], worktree)
  return cmdSubmit(ctx(), { taskId, title, repoKey: null, runId }, { openPr: async () => ({ pr: null }) })
}

/** A reviewer: its verdict file is committed and pushed onto the branch it reviewed. */
function pushVerdict(worktree: string, bead: string): void {
  commitAs(worktree, `docs/superpowers/reviews/${bead}-pr-review-0.md`, 'VERDICT: CLEAR\n')
  git(['push', '-q', 'origin', 'HEAD'], worktree)
}

/** The orchestrator runs the landing command exactly as `merge-batch.md` rendered it. */
async function land(runId: string, taskId: string): Promise<string> {
  const run = await loaded(runId)
  const task = taskOf(run, taskId)
  const prompt = await renderTaskPhasePrompt(run, task, { pluginRoot: ROOT, ciDetail: async () => '' }, 'merge')
  const command = prompt.split('\n').find((line) => line.startsWith('    git -C '))!.trim()
  sh(command, tempDir('hpipe-orchestrator-cwd-'))
  return command
}

async function closeBead(runId: string, taskId: string): Promise<string> {
  const run = await loaded(runId)
  recordBeadClosed(taskId, Date.now())(run)
  await saveRun(stateDir, run)
  return closeReason(taskOf(run, taskId), run)
}

/** `start --single-pr`, then each task registered, dispatched and in `implement` in a worktree of its own. */
async function startedRun(taskIds: string[]) {
  stateDir = mkdtempSync(join(tmpdir(), 'single-pr-wiring-'))
  const { remote, clone } = cloneOfRemote('main')
  mkdirSync(join(clone, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(clone, '.claude', 'agents', 'core-dev.md'), '# core\n')
  writeFileSync(join(clone, '.claude', 'pipeline-check'), '#!/bin/sh\ntest ! -e broken.txt\n')
  chmodSync(join(clone, '.claude', 'pipeline-check'), 0o755)
  git(['add', '-A'], clone)
  git(['commit', '-qm', 'chore: declare the check'], clone)
  git(['push', '-q', 'origin', 'HEAD:main'], clone)

  const started = await cmdStart(ctx(), {
    title: 'reader menu', repoKey: clone, repoRoot: clone, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
    singlePr: true, batchBranch: 'batch/menu',
  }, undefined, startBatch())
  expect(started.ok).toBe(true)
  const runId = JSON.parse(started.json!).run_id as string
  const base = revParse(clone, 'refs/remotes/origin/main')
  expect(started.text).toContain(`batch: batch/menu at ${base.slice(0, 8)}`)

  for (const [index, id] of taskIds.entries()) {
    const registered = await cmdTask(ctx(), {
      branch: `${id}-branch`, bead: `hp-${index + 1}`, surface: 'core', notes: '', dependsOn: [], files: [],
      keepWorktree: false, repoKey: clone, runId, tier: 'light',
    })
    expect(registered.text, id).toContain(`base: ${base} (origin/batch/menu as just fetched)`)
  }

  const worktrees: Record<string, string> = {}
  const run = await loaded(runId)
  for (const task of run.tasks) {
    const worktree = join(tempDir('hpipe-wt-'), task.task_id)
    git(['worktree', 'add', '-q', '-b', task.branch, worktree, base], clone)
    git(['push', '-q', '-u', 'origin', task.branch], worktree)
    worktrees[task.task_id] = worktree
    Object.assign(task, {
      phase: 'implement', phase_entered_at: Date.now() - 1_000, checkout_path: worktree,
      workspace_id: `w-${task.task_id}`, pane_id: `w-${task.task_id}:p1`, adopted_at: Date.now(),
    })
    delete task.awaiting_brief
  }
  run.intake_closed = true
  run.phase = 'execute'
  await saveRun(stateDir, run)
  return { remote, clone, runId, worktrees }
}

test('two tasks land one at a time on the batch branch, which ships as one squash-merged PR', async () => {
  const { remote, clone, runId, worktrees } = await startedRun(['t1', 't2'])

  // implement → pr-review on each submission
  expect((await workAndSubmit(runId, 't1', worktrees.t1!, 'src/menu.ts', "fix(menu): don't re-render")).ok).toBe(true)
  expect((await workAndSubmit(runId, 't2', worktrees.t2!, 'src/bookmarks.ts', 'feat(reader): add bookmarks')).ok)
    .toBe(true)
  const verdicts = new Map<string, 'CLEAR'>()
  await supervisorTick(runId, verdicts)
  expect(await phases(runId)).toEqual({ t1: 'pr-review', t2: 'pr-review' })

  // both reviews clear onto heads that add only their verdicts: checked, so no sync is owed for that
  pushVerdict(worktrees.t2!, 'hp-2')
  verdicts.set('t2', 'CLEAR')
  await supervisorTick(runId, verdicts)
  pushVerdict(worktrees.t1!, 'hp-1')
  verdicts.set('t1', 'CLEAR')
  const reviewed = await supervisorTick(runId, verdicts)
  expect(taskOf(reviewed, 't1').land_sha).toBe(revParse(worktrees.t1!, 'HEAD'))
  // t2 cleared first, so it is first in line; t1 waits behind it in the same tick.
  expect(await phases(runId)).toEqual({ t1: 'land-queue', t2: 'merge' })

  // t2 lands as a fast-forward and closes with the batch reason
  const command = await land(runId, 't2')
  expect(command).toStartWith(`git -C '${clone}' push origin `)
  await supervisorTick(runId, verdicts)
  expect(await phases(runId)).toMatchObject({ t2: 'close' })
  expect(revParse(clone, 'refs/remotes/origin/batch/menu')).toBe(taskOf(await loaded(runId), 't2').land_sha!)
  expect(await closeBead(runId, 't2')).toMatch(/^landed on batch\/menu \([0-9a-f]{8}\); ships with the batch PR into main$/)

  // t1 was behind the moment t2 landed: it takes the slot into sync, and its old head is refused
  await supervisorTick(runId, verdicts)
  expect(await phases(runId)).toEqual({ t1: 'sync', t2: 'teardown' })
  const stale = Bun.spawnSync(['git', '-C', clone, 'push', 'origin',
    `${taskOf(await loaded(runId), 't1').land_sha}:refs/heads/batch/menu`], { stderr: 'pipe' })
  expect(stale.success).toBe(false)

  // a clean sync is checked and lands with no second review
  git(['fetch', '-q', 'origin', '+refs/heads/batch/menu:refs/remotes/origin/batch/menu'], worktrees.t1!)
  git(['merge', '-q', '--no-edit', 'origin/batch/menu'], worktrees.t1!)
  git(['push', '-q', 'origin', 'HEAD'], worktrees.t1!)
  const synced = await cmdSubmit(ctx(), { taskId: 't1', title: null, repoKey: null, runId }, { openPr: async () => ({ pr: null }) })
  expect(synced.text).toContain('a clean merge of batch/menu: it lands next')
  await supervisorTick(runId, verdicts)
  expect(await phases(runId)).toEqual({ t1: 'merge', t2: 'done' })
  await land(runId, 't1')
  await supervisorTick(runId, verdicts)
  await closeBead(runId, 't1')
  await supervisorTick(runId, verdicts)
  await supervisorTick(runId, verdicts)
  expect(await phases(runId)).toEqual({ t1: 'done', t2: 'done' })

  // the run's end: branch review, ship, CI once, the squash merge
  let pr: PrView & { open: boolean } = { merged: false, mergedAtMs: null, mergeCommit: null, headSha: null, open: false }
  const gh = {
    prForBranch: async (branch: string) => (branch === 'batch/menu' && pr.open ? 301 : null),
    prView: async () => ({ ...pr, headSha: revParse(clone, 'refs/remotes/origin/batch/menu') }),
    prChecksDetail: async () => '',
  }
  const evaluate = async () => {
    const run = await loaded(runId)
    const result = await evaluateRun(run, gh, CONFIG, async () => true, { stateDir })
    await saveRun(stateDir, run)
    return { run, result }
  }

  const toReview = await evaluate()
  expect(toReview.run.phase).toBe('branch-review')
  expect(toReview.result.nextPrompt).toContain('git diff origin/main...origin/batch/menu')
  const verdictPath = absoluteArtifactPath(toReview.run, null)!
  mkdirSync(join(verdictPath, '..'), { recursive: true })
  writeFileSync(verdictPath, 'VERDICT: CLEAR\n')
  // A verdict is fresh only when written after the phase entry; written in the same millisecond, as
  // a fast test can, it reads as stale. A reviewer takes minutes.
  const writtenAfterEntry = new Date(toReview.run.phase_entered_at + 1_000)
  utimesSync(verdictPath, writtenAfterEntry, writtenAfterEntry)

  const toShip = await evaluate()
  expect(toShip.run.phase).toBe('ship')
  const body = readFileSync(join(stateDir, 'runs', 'personal', `${runId}.batch-pr.md`), 'utf8')
  expect(body).toContain("BEGIN_COMMIT_OVERRIDE\nfeat(reader): add bookmarks\nfix(menu): don't re-render\nEND_COMMIT_OVERRIDE")

  // the orchestrator follows the ship prompt: the batch checkout, the combined check, the PR
  for (const line of toShip.result.nextPrompt.split('\n').filter((l) => l.startsWith('       git -C '))) {
    sh(line.trim(), clone)
  }
  const checked = await cmdBatchCheck(ctx(), { repoKey: null, runId })
  expect(checked.text).toContain('.claude/pipeline-check passed')
  expect((await evaluate()).run.phase).toBe('ship')
  pr = { ...pr, open: true }
  expect((await evaluate()).run.phase).toBe('ship-ci')

  // CI once, held for the settle window on the head it read
  const head = revParse(clone, 'refs/remotes/origin/batch/menu')
  const now = Date.now()
  for (const at of [now, now + CI_SETTLE_MS]) {
    const run = await loaded(runId)
    await ciTransitions([run], async () => ({ bucket: 'pass', headSha: head }), at)
    await saveRun(stateDir, run)
  }
  const toMerge = await evaluate()
  expect(toMerge.run.phase).toBe('ship-merge')
  expect(toMerge.result.nextPrompt).toContain("--squash --subject 'feat(reader): add bookmarks'")
  expect(readFileSync(join(stateDir, 'runs', 'personal', `${runId}.squash-body.md`), 'utf8'))
    .toBe("fix(menu): don't re-render\n")

  pr = { ...pr, merged: true, mergedAtMs: Date.now(), mergeCommit: 'f00dfeed00' }
  const shipped = await evaluate()
  expect(shipped.run.phase).toBe('done')
  expect(shipped.result.nextPrompt).toContain('shipped: PR #301 squash-merged as f00dfeed')
  expect(shipped.result.nextPrompt).toContain(`git -C '${clone}' push origin --delete t1-branch t2-branch`)
  expect((await listRuns(stateDir, 'personal'))[0]?.batch?.merge_commit).toBe('f00dfeed00')
  expect(remote.length).toBeGreaterThan(0)
}, 60_000)

test('a branch tip landed in place of the reviewed head is recorded and closes, rather than wedging in sync', async () => {
  const { clone, runId, worktrees } = await startedRun(['t1'])
  const worktree = worktrees.t1!
  expect((await workAndSubmit(runId, 't1', worktree, 'src/menu.ts', 'fix(menu): close on escape')).ok).toBe(true)
  const verdicts = new Map<string, 'CLEAR'>()
  await supervisorTick(runId, verdicts)
  pushVerdict(worktree, 'hp-1')
  verdicts.set('t1', 'CLEAR')
  await supervisorTick(runId, verdicts)
  await supervisorTick(runId, verdicts)
  expect(await phases(runId)).toEqual({ t1: 'merge' })
  const landSha = taskOf(await loaded(runId), 't1').land_sha!

  // a commit pushed after the review, and the orchestrator lands the branch tip instead of the printed sha
  commitAs(worktree, 'src/late.ts', 'late\n')
  git(['push', '-q', 'origin', 'HEAD'], worktree)
  sh(`git push origin ${revParse(worktree, 'HEAD')}:refs/heads/batch/menu`, clone)

  const run = await supervisorTick(runId, verdicts)
  expect(taskOf(run, 't1').phase).toBe('close')
  expect(taskOf(run, 't1').landed?.map((l) => l.land_sha)).toEqual([landSha])
  expect(taskOf(run, 't1').merge_commit).toBe(landSha)
}, 60_000)
