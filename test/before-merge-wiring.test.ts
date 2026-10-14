import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BeforeMergeReads, cmdAnswer, cmdConfirm, cmdDecide, cmdHold, cmdRewind } from '../src/cli'
import type { Config } from '../src/lib/config'
import { forgetDispatchBases, remoteBranchHead } from '../src/lib/dispatch-base'
import type { PrView } from '../src/lib/gh'
import { loadRun, saveRun } from '../src/lib/ledger'
import { hpipeCommand } from '../src/lib/render'
import type { Run, Task } from '../src/lib/types'
import { CI_SETTLE_MS, ciTransitions } from '../src/supervisor/ci'
import { evaluateRun } from '../src/supervisor/deliver'
import {
  applyStalls, stallAwaiting, type StallCandidate, stallCandidates, type StallDeps, taskStallCandidates,
} from '../src/supervisor/stall'
import { advanceTasks, deliverPendingAnswers, type TaskDeps } from '../src/supervisor/tasks'
import { cmdStart, startBatch } from './helpers/cmd-start'
import { cmdTask } from './helpers/cmd-task'
import { cleanupFixtures, cloneOfRemote, commitAs, git, revParse } from './helpers/git-worktree'

/**
 * Before-merge checks against a real ledger, the real CLI functions and the
 * supervisor's own step functions, in the order a live run takes them. Only herdr,
 * gh and Beads are faked: unit tests with fakes have missed live-only wiring bugs.
 */

const ROOT = join(import.meta.dir, '..')
const ORCHESTRATOR = 'w1:p1'
const TASK_STALL_MINUTES = 45
const STALL_MINUTES = 15
const CONFIG = { MAX_PASSES: 2, FILE_SETTLE_MS: 0, ACTOR_SETTLE_MS: 0 } as Config
let stateDir: string
const ctx = () => ({ stateDir, pluginRoot: ROOT, session: 'personal' })

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  forgetDispatchBases()
  cleanupFixtures()
})

const loaded = async (runId: string): Promise<Run> => (await loadRun(stateDir, 'personal', runId))!
const taskOf = (run: Run): Task => run.tasks[0]!

/** A gh that answers for one PR, whose head and merge the test moves. */
function fakeGitHub(number: number, branch: string) {
  const pr: PrView = { merged: false, mergedAtMs: null, mergeCommit: null, headSha: null }
  return {
    pr,
    prForBranch: async (asked: string) => (asked === branch ? number : null),
    prView: async () => ({ ...pr }),
    prChecksDetail: async () => '',
    headCi: async () => (pr.headSha === null ? null : { bucket: 'pass' as const, headSha: pr.headSha }),
  }
}

/** No supervisor pid in the temp state dir, the fake gh, and the real `git ls-remote` for the live head. */
const readsFrom = (gh: ReturnType<typeof fakeGitHub>): BeforeMergeReads => ({
  supervisor: async () => ({ state: 'none' }),
  prView: gh.prView,
  branchHead: remoteBranchHead,
})

function supervisorDeps(gh: ReturnType<typeof fakeGitHub>, verdicts: Set<string>): TaskDeps {
  return {
    pluginRoot: ROOT,
    liveIdle: async () => true,
    hasLiveAgent: () => true,
    maxPasses: 2,
    fileSettleMs: 0,
    prForBranch: gh.prForBranch,
    prView: gh.prView,
    verdictFor: async (_run, task) => {
      if (!verdicts.delete(task.task_id)) return null
      return { verdict: 'CLEAR', blockers: 0, majors: 0 }
    },
    removeWorktree: async () => 'removed',
    removeCheckout: async () => ({ removed: true }),
    ciDetail: async () => '',
    ambiguityLog: new Set<string>(),
    uncommittedPaths: async () => [],
    freshDispatchBase: async () => { throw new Error('no task is dispatched by the supervisor here') },
  }
}

/** One supervisor pass over the run's tasks, saved the way `main.ts` saves it. */
async function taskTick(runId: string, deps: TaskDeps) {
  const run = await loaded(runId)
  const prompts = await advanceTasks(run, deps)
  await saveRun(stateDir, run)
  return { run, prompts }
}

/** CI read twice across its settle window, as the poller reads it. */
async function ciPasses(runId: string, gh: ReturnType<typeof fakeGitHub>): Promise<void> {
  const now = Date.now()
  for (const at of [now, now + CI_SETTLE_MS]) {
    const run = await loaded(runId)
    await ciTransitions([run], gh.headCi, at)
    await saveRun(stateDir, run)
  }
}

/** The supervisor's stall step at `now`, with a probe that records what it would send. */
async function stallsAt(runId: string, now: number): Promise<string[]> {
  const sent: string[] = []
  const deps: StallDeps = {
    probeMax: 3,
    now: () => now,
    probe: async (c: StallCandidate) => {
      sent.push(stallAwaiting(c.run, c.task, hpipeCommand(ROOT), now).clause)
      return { ok: true }
    },
    escalationText: async () => { throw new Error('a gate row never escalates') },
    queueEscalation: () => { throw new Error('a gate row never escalates') },
    agentStatus: async () => 'idle',
    persist: async (run) => { await saveRun(stateDir, run) },
    limited: async () => false,
  }
  const runs = [await loaded(runId)]
  await applyStalls([
    ...stallCandidates(runs, now, STALL_MINUTES, 3),
    ...taskStallCandidates(runs, now, TASK_STALL_MINUTES, 3, STALL_MINUTES),
  ], deps)
  return sent
}

function repoWithAgent(): { clone: string } {
  const { clone } = cloneOfRemote('main')
  mkdirSync(join(clone, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(clone, '.claude', 'agents', 'core-dev.md'), '# core\n')
  return { clone }
}

test('per-task: a check carried by an answer holds the merge, draws no probe, outlives a merge, and lifts on a ruling', async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'before-merge-wiring-'))
  const { clone } = repoWithAgent()
  const started = await cmdStart(ctx(), {
    title: 'reader ghost', repoKey: clone, repoRoot: clone, socketPath: '/s', paneId: ORCHESTRATOR, workspaceId: 'w1',
  })
  const runId = JSON.parse(started.json!).run_id as string
  expect((await cmdTask(ctx(), {
    branch: 'feat/ghost', bead: 'hp-1', surface: 'core', notes: '', dependsOn: [], files: [], keepWorktree: false,
    repoKey: clone, runId, tier: 'heavy',
  }, undefined, async () => ({ commit: 'c0ffee1', ref: 'origin/main', fetchError: null }))).ok).toBe(true)
  const placed = await loaded(runId)
  Object.assign(taskOf(placed), {
    phase: 'implement', phase_entered_at: Date.now() - 1_000, checkout_path: clone,
    workspace_id: 'w7', pane_id: 'w7:p1', adopted_at: Date.now(),
  })
  delete taskOf(placed).awaiting_brief
  placed.intake_closed = true
  placed.phase = 'execute'
  await saveRun(stateDir, placed)

  // the worker asks; the orchestrator answers and records what only the human can check
  expect((await cmdDecide(ctx(), {
    task: 't1', question: 'ghost on page turn?', recommendation: 'fix it', repoKey: null, runId,
  })).ok).toBe(true)
  const gh = fakeGitHub(255, 'feat/ghost')
  const answered = await cmdAnswer(ctx(), {
    task: 't1', decision: 'd1', answer: 'fix the ghost', by: 'orchestrator', repoKey: null, runId,
    beforeMerge: ['the reader shows no ghost after a page turn'], callerPane: ORCHESTRATOR,
  }, readsFrom(gh))
  expect(answered.text).toContain('c1 recorded on t1')

  // the supervisor delivers the answer, carrying the check, and the worker resumes implement
  const sent: string[] = []
  for (const submitted of [false, true]) {
    const run = await loaded(runId)
    await deliverPendingAnswers(run, {
      pluginRoot: ROOT, promptRetryMax: 5,
      send: async (_pane, text) => { sent.push(text); return { ok: true } },
      checkSubmission: async () => ({ state: submitted ? 'submitted' : 'pending' }),
    })
    await saveRun(stateDir, run)
  }
  expect(sent[0]).toContain('Before this merges, the human will check:\n\n- the reader shows no ghost after a page turn')
  expect(taskOf(await loaded(runId)).phase).toBe('implement')

  // implement → pr-review → ci → merge, where the orchestrator's prompt is the hold
  const verdicts = new Set<string>()
  const deps = supervisorDeps(gh, verdicts)
  gh.pr.headSha = 'aaa1111' + '0'.repeat(33)
  expect((await taskTick(runId, deps)).run.tasks[0]?.phase).toBe('pr-review')
  verdicts.add('t1')
  expect((await taskTick(runId, deps)).run.tasks[0]?.phase).toBe('ci')
  await ciPasses(runId, gh)
  const toMerge = await taskTick(runId, deps)
  expect(taskOf(toMerge.run).phase).toBe('merge')
  expect(toMerge.prompts).toHaveLength(1)
  expect(toMerge.prompts[0]?.paneId).toBe(ORCHESTRATOR)
  expect(toMerge.prompts[0]?.text).toStartWith('# Hold — PR #255 (feat/ghost, hp-1) waits on the human before it merges')
  expect(toMerge.prompts[0]?.text).not.toContain('gh pr merge')

  // no probe, however long the human takes
  expect(await stallsAt(runId, Date.now() + 3 * TASK_STALL_MINUTES * 60_000 + 1)).toEqual([])

  // merged by hand while held: recorded, and the task stays in merge
  Object.assign(gh.pr, { merged: true, mergedAtMs: Date.now(), mergeCommit: 'm3rg3' })
  const merged = await taskTick(runId, deps)
  expect(taskOf(merged.run)).toMatchObject({ phase: 'merge', merged_at_ms: gh.pr.mergedAtMs, merge_commit: 'm3rg3' })
  expect(merged.prompts).toEqual([])

  const rewound = await cmdRewind(ctx(), { runId, phase: 'done', taskId: 't1' }, async () => true)
  expect(rewound.ok).toBe(false)
  expect(rewound.text).toContain('t1 owes c1 to the human')

  // the ruling, after the merge, reads no branch and queues nothing; the next tick closes
  const confirmed = await cmdConfirm(ctx(), {
    checkId: 'c1', by: 'human', waive: null, failed: null, repoKey: null, runId, callerPane: ORCHESTRATOR,
  }, { ...readsFrom(gh), branchHead: async () => { throw new Error('no live read after a merge') } })
  expect(confirmed.text).toContain('nothing more is owed, and t1 has merged')
  expect((await loaded(runId)).outbox ?? []).toEqual([])
  expect(taskOf((await taskTick(runId, deps)).run).phase).toBe('close')
}, 60_000)

test('single-PR: a run check holds ship-merge, a failure waits on a fix, a new head is checked again, and a ruling ships it', async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'before-merge-wiring-'))
  const { clone } = repoWithAgent()
  const started = await cmdStart(ctx(), {
    title: 'reader menu', repoKey: clone, repoRoot: clone, socketPath: '/s', paneId: ORCHESTRATOR, workspaceId: 'w1',
    singlePr: true, batchBranch: 'batch/menu',
  }, undefined, startBatch())
  expect(started.ok, started.text).toBe(true)
  const runId = JSON.parse(started.json!).run_id as string
  const gh = fakeGitHub(301, 'batch/menu')

  // at intake, the user says they will check the menu themselves
  const held = await cmdHold(ctx(), {
    checks: ['the menu closes on a long press'], taskId: null, repoKey: null, runId, callerPane: ORCHESTRATOR,
  }, readsFrom(gh))
  expect(held.text).toBe('c1 recorded: the batch PR does not merge until the human rules on "the menu closes on a long press"')

  // the batch has shipped as far as CI: its PR is open on the head batch-check recorded
  const h1 = revParse(clone, 'refs/remotes/origin/batch/menu')
  const shipping = await loaded(runId)
  shipping.phase = 'ship-ci'
  shipping.phase_entered_at = Date.now()
  shipping.intake_closed = true
  shipping.batch!.pr = 301
  shipping.batch!.checked = { head_sha: h1, at: Date.now(), check: 'passed' }
  await saveRun(stateDir, shipping)
  gh.pr.headSha = h1
  const evaluate = async () => {
    const run = await loaded(runId)
    const result = await evaluateRun(run, gh, CONFIG, async () => true, { stateDir })
    await saveRun(stateDir, run)
    return { run, result }
  }

  await ciPasses(runId, gh)
  const atTheGate = await evaluate()
  expect(atTheGate.run.phase).toBe('ship-merge')
  expect(atTheGate.result.nextPrompt).toStartWith('# Hold — the batch PR #301 waits on the human before it merges')
  expect(await stallsAt(runId, Date.now() + 3 * STALL_MINUTES * 60_000 + 1)).toEqual([])

  // the human finds it broken: the run stays, and its probe is the fix's
  const failed = await cmdConfirm(ctx(), {
    checkId: 'c1', by: 'human', waive: null, failed: 'the menu stays open', repoKey: null, runId, callerPane: ORCHESTRATOR,
  }, readsFrom(gh))
  expect(failed.text).toContain(`c1 failed on ${h1.slice(0, 8)}: the run stays in ship-merge`)
  expect((await evaluate()).run.phase).toBe('ship-merge')
  const [probe] = await stallsAt(runId, Date.now() + STALL_MINUTES * 60_000 + 1)
  expect(probe).toContain('This phase waits on a fix, which is yours')

  // a patch on the batch moves the head: back through ship and CI, and the human checks the new head
  const checkout = join(clone, '..', 'batch-checkout')
  git(['worktree', 'add', '-q', '--track', '-B', 'batch/menu', checkout, 'origin/batch/menu'], clone)
  commitAs(checkout, 'src/menu.ts', 'closes\n')
  git(['push', '-q', 'origin', 'HEAD:batch/menu'], checkout)
  const h2 = revParse(checkout, 'HEAD')
  gh.pr.headSha = h2
  expect((await evaluate()).run.phase).toBe('ship')
  const checked = await loaded(runId)
  checked.batch!.checked = { head_sha: h2, at: Date.now(), check: 'passed' }
  await saveRun(stateDir, checked)
  expect((await evaluate()).run.phase).toBe('ship-ci')
  await ciPasses(runId, gh)
  const again = await evaluate()
  expect(again.run.phase).toBe('ship-merge')
  expect(again.result.nextPrompt).toContain(`failed on ${h1.slice(0, 8)}: the menu stays open; the fix is in`)

  const confirmed = await cmdConfirm(ctx(), {
    checkId: 'c1', by: 'human', waive: null, failed: null, repoKey: null, runId, callerPane: ORCHESTRATOR,
  }, readsFrom(gh))
  expect(confirmed.text).toBe(`c1 confirmed by the human on ${h2.slice(0, 8)}; nothing more is owed before PR #301 ` +
    'merges: its merge prompt is queued for you')
  const queued = (await loaded(runId)).outbox ?? []
  expect(queued).toHaveLength(1)
  expect(queued[0]?.text).toContain(`--squash --match-head-commit ${h2}`)
  expect(queued[0]?.text).toContain(`Before merge: c1 confirmed by the human on ${h2.slice(0, 8)}.`)

  Object.assign(gh.pr, { merged: true, mergedAtMs: Date.now(), mergeCommit: 'f00dfeed00' })
  const shipped = await evaluate()
  expect(shipped.run.phase).toBe('done')
  expect(shipped.result.nextPrompt).toContain(`before merge: c1 confirmed by the human on ${h2.slice(0, 8)}`)
}, 60_000)
